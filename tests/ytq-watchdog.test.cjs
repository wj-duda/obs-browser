const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'browser-client.cpp'), 'utf8');
const script = source.match(/R"YTQJS\(([\s\S]*?)\)YTQJS"/)[1];

function harness({ videoId = 'first', quality = 'hd720', levels = ['hd1080', 'hd720'] } = {}) {
    let now = 0;
    let available = true;
    const calls = [];
    const logs = [];
    const timers = [];
    const listeners = {};
    const player = {
        getVideoData: () => ({ video_id: videoId }),
        getPlaybackQuality: () => quality,
        getAvailableQualityLevels: () => levels,
        setPlaybackQualityRange: (...args) => calls.push(args),
    };
    const context = vm.createContext({
        console: Object.fromEntries(['info', 'warn', 'error'].map(level => [
            level, (...args) => logs.push(args.join(' ')),
        ])),
        performance: { now: () => now },
        location: { pathname: '/embed/', href: 'https://www.youtube.com/embed/' },
        document: {
            getElementById: () => available ? player : null,
            querySelector: () => available ? player : null,
            addEventListener: (name, fn) => { listeners[name] = fn; },
        },
        setTimeout: (fn, delay) => timers.push({ fn, delay, interval: false }),
        setInterval: (fn, delay) => timers.push({ fn, delay, interval: true }),
    });
    context.window = context;
    context.addEventListener = (name, fn) => { listeners[name] = fn; };
    const run = () => vm.runInContext(script, context);
    const tick = (time = now) => {
        now = time;
        timers.find(timer => timer.interval).fn();
    };
    return {
        calls, logs, timers, player, run, tick,
        setVideo: value => { videoId = value; },
        setQuality: value => { quality = value; },
        setAvailable: value => { available = value; },
    };
}

test('forces 1080p and stops applying once playback reaches it', () => {
    const h = harness();
    h.run();
    h.tick();
    assert.deepEqual(h.calls, [['hd1080', 'hd1080']]);
    h.setQuality('hd1080');
    h.tick(3000);
    assert.equal(h.calls.length, 1);
});

test('uses the best available quality when 1080p is missing', () => {
    const h = harness({ quality: 'small', levels: ['medium', 'hd720', 'large'] });
    h.run();
    h.tick();
    assert.deepEqual(h.calls, [['hd720', 'hd720']]);
});

test('supports a blank embed before and after a video ID becomes available', () => {
    const h = harness({ videoId: undefined });
    // Explicitly clear the ID after harness defaults are applied.
    h.setVideo(undefined);
    h.run();
    h.tick();
    assert.equal(h.calls.length, 1);
    h.setVideo('loaded-later');
    h.tick(500);
    assert.equal(h.calls.length, 2);
    assert.ok(h.logs.some(line => line.includes('VIDEO_CHANGED video=loaded-later')));
});

test('limits repeated quality requests but retries a later downgrade', () => {
    const h = harness();
    h.run();
    h.tick();
    h.tick(500);
    h.tick(1999);
    assert.equal(h.calls.length, 1);
    h.tick(2000);
    assert.equal(h.calls.length, 2);
    h.setQuality('hd1080');
    h.tick(2500);
    h.setQuality('hd720');
    h.tick(4500);
    assert.equal(h.calls.length, 3);
    assert.ok(h.logs.some(line => line.includes('DOWNGRADE')));
});

test('does not install duplicate intervals when reinjected into the same frame', () => {
    const h = harness();
    h.run();
    h.run();
    assert.equal(h.timers.filter(timer => timer.interval).length, 1);
});

test('survives missing players and stale verification after navigation', () => {
    const h = harness();
    h.setAvailable(false);
    h.run();
    h.tick();
    assert.equal(h.calls.length, 0);
    h.setAvailable(true);
    h.tick(500);
    const verification = h.timers.at(-1);
    h.setVideo('next-video');
    verification.fn();
    assert.ok(!h.logs.some(line => line.includes('VERIFY')));
});

test('handles an unavailable or failing YouTube quality API without throwing', () => {
    const h = harness();
    delete h.player.setPlaybackQualityRange;
    h.run();
    h.tick();
    h.tick(500);
    assert.equal(h.logs.filter(line => line.includes('METHOD_UNAVAILABLE')).length, 1);
    h.player.setPlaybackQualityRange = () => { throw new Error('player disposed'); };
    assert.doesNotThrow(() => h.tick(2500));
    assert.ok(h.logs.some(line => line.includes('setPlaybackQualityRange failed')));
});
