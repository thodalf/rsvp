// Musique d'ambiance générée en direct par le navigateur (Web Audio).
//
// L'ancienne version lisait des MP3 hébergés chez un tiers : si le lien cassait, plus de musique.
// Ici rien n'est téléchargé : nappes d'accords, arpèges et basses sont synthétisés à la volée,
// fonctionnent hors ligne, et passent en fondu enchaîné d'une ambiance à l'autre.

const PROFILES = {
    calm:       { root: 57, chords: [[0, 4, 7, 11], [5, 9, 12, 16], [-3, 0, 4, 7], [7, 11, 14, 16]], sec: 9, wave: 'sine', cutoff: 1400, pluck: { notes: [0, 2, 4, 7, 9], rate: 0.22 } },
    sad:        { root: 50, chords: [[0, 3, 7, 10], [-4, 0, 3, 7], [5, 8, 12, 15], [7, 12, 14, 17]], sec: 10, wave: 'sine', cutoff: 1100, pluck: { notes: [0, 3, 5, 7, 10], rate: 0.12 } },
    romantic:   { root: 53, chords: [[0, 4, 7, 11, 14], [-3, 0, 4, 7, 11], [5, 9, 12, 16], [7, 11, 14, 16]], sec: 8, wave: 'triangle', cutoff: 1500, pluck: { notes: [0, 2, 4, 7, 9], rate: 0.2 } },
    mysterious: { root: 50, chords: [[0, 4, 8, 11], [2, 6, 10, 13], [0, 6, 9, 14], [-2, 2, 6, 9]], sec: 11, wave: 'sine', cutoff: 900, wet: 0.65, pluck: { notes: [0, 2, 4, 6, 8, 10], rate: 0.15 } },
    tense:      { root: 45, chords: [[0, 1, 7], [0, 3, 6], [-1, 0, 6], [1, 4, 7]], sec: 6, wave: 'sawtooth', cutoff: 650, drone: -12, tremolo: { rate: 5, depth: 0.35 } },
    dark:       { root: 38, chords: [[0, 3, 7], [1, 5, 8], [-2, 1, 5], [0, 3, 6]], sec: 12, wave: 'sawtooth', cutoff: 450, drone: -12, pluck: { notes: [0, 1, 3, 7], rate: 0.07, octave: 0 } },
    epic:       { root: 45, chords: [[0, 3, 7, 12], [-4, 0, 3, 8], [3, 7, 10, 15], [-2, 2, 5, 10]], sec: 4, wave: 'sawtooth', cutoff: 1800, boom: true },
    adventure:  { root: 50, chords: [[0, 4, 7, 12], [-2, 2, 5, 10], [5, 9, 12, 17], [7, 11, 14, 19]], sec: 5, wave: 'triangle', cutoff: 2000, arp: { notes: [0, 2, 4, 7, 9, 12], beat: 0.3, prob: 0.7 } },
    upbeat:     { root: 55, chords: [[0, 4, 7, 12], [-3, 0, 4, 9], [5, 9, 12, 17], [7, 11, 14, 19]], sec: 3.2, wave: 'triangle', cutoff: 2500, arp: { notes: [0, 2, 4, 7, 9, 12], beat: 0.25, prob: 0.75 } }
};

const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);
const pick = arr => arr[(Math.random() * arr.length) | 0];

function makeImpulse(ctx, seconds = 3, decay = 2.5) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
}

/** Une ambiance en cours de lecture (nappe + motifs), avec son propre volume pour les fondus. */
class Layer {
    constructor(amb, mood) {
        const ctx = amb.ctx;
        this.ctx = ctx;
        this.p = PROFILES[mood];
        this.timers = new Set();
        this.alive = true;

        this.out = ctx.createGain();
        this.out.gain.value = 0;
        this.filter = ctx.createBiquadFilter();
        this.filter.type = 'lowpass';
        this.filter.frequency.value = this.p.cutoff;
        this.filter.Q.value = 0.6;
        this.filter.connect(this.out);
        this.out.connect(amb.dry);
        const send = ctx.createGain();
        send.gain.value = this.p.wet || 0.45;
        this.out.connect(send);
        send.connect(amb.reverb);
        this.send = send;

        if (this.p.tremolo) {
            const lfo = ctx.createOscillator();
            const depth = ctx.createGain();
            const trem = ctx.createGain();
            lfo.frequency.value = this.p.tremolo.rate;
            depth.gain.value = this.p.tremolo.depth;
            trem.gain.value = 1 - this.p.tremolo.depth;
            lfo.connect(depth); depth.connect(trem.gain);
            this.filter.disconnect(); this.filter.connect(trem); trem.connect(this.out);
            lfo.start();
            this.lfo = lfo;
        }
        if (this.p.drone !== undefined) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = hz(this.p.root + this.p.drone);
            g.gain.value = 0.16;
            o.connect(g); g.connect(this.filter);
            o.start();
            this.drone = o;
        }
        this.chordIndex = 0;
        this._chord();
        if (this.p.pluck) this._pluck();
        if (this.p.arp) this._arp();
    }

    _later(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            if (!this.alive) return;
            // En pause, l'horloge audio est gelée : on attend la reprise au lieu d'empiler des notes.
            if (this.ctx.state === 'running') fn(); else this._later(fn, 500);
        }, ms);
        this.timers.add(t);
    }

    _chord() {
        const { ctx, p } = this;
        const chord = p.chords[this.chordIndex++ % p.chords.length];
        const now = ctx.currentTime;
        const dur = p.sec;
        const attack = Math.min(2.5, dur * 0.35), release = Math.min(4, dur * 0.6);
        const peak = 0.22 / chord.length;
        for (const n of chord) {
            for (const det of [-7, 7]) {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.type = p.wave;
                o.frequency.value = hz(p.root + n);
                o.detune.value = det;
                g.gain.setValueAtTime(0, now);
                g.gain.linearRampToValueAtTime(peak, now + attack);
                g.gain.setValueAtTime(peak, now + dur);
                g.gain.linearRampToValueAtTime(0, now + dur + release);
                o.connect(g); g.connect(this.filter);
                o.start(now);
                o.stop(now + dur + release + 0.1);
            }
        }
        if (p.boom) this._boom(now);
        this._later(() => this._chord(), dur * 1000);
    }

    _boom(t) {
        const { ctx } = this;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(42, t + 0.6);
        g.gain.setValueAtTime(0.5, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
        o.connect(g); g.connect(this.out);
        o.start(t); o.stop(t + 1.5);
    }

    _note(semi, { gain = 0.07, decay = 1.8, type = 'triangle' } = {}) {
        const { ctx, p } = this;
        const t = ctx.currentTime + 0.02;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.value = hz(p.root + semi);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
        o.connect(g); g.connect(this.out); g.connect(this.send);
        o.start(t); o.stop(t + decay + 0.05);
    }

    _pluck() {
        const { notes, rate, octave = 12 } = this.p.pluck;
        this._note(octave + pick(notes), { type: 'sine', gain: 0.06, decay: 2.4 });
        const wait = -Math.log(1 - Math.random()) / rate;   // intervalles irréguliers, naturels
        this._later(() => this._pluck(), Math.min(12, Math.max(0.6, wait)) * 1000);
    }

    _arp() {
        const { notes, beat, prob } = this.p.arp;
        if (Math.random() < prob) this._note(12 + pick(notes), { gain: 0.045, decay: 0.9 });
        this._later(() => this._arp(), beat * 1000);
    }

    fade(to, seconds) {
        const g = this.out.gain, now = this.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(to, now + seconds);
    }

    dispose(afterSeconds) {
        setTimeout(() => {
            this.alive = false;
            this.timers.forEach(clearTimeout);
            this.timers.clear();
            try { this.lfo && this.lfo.stop(); this.drone && this.drone.stop(); } catch { /* déjà arrêté */ }
            this.out.disconnect();
        }, afterSeconds * 1000 + 200);
    }
}

export class Ambience {
    constructor() {
        this.ctx = null;
        this.layer = null;
        this.mood = null;
        this.volume = 0.35;
        this.running = false;
        this._suspendTimer = null;
    }

    get supported() { return typeof (window.AudioContext || window.webkitAudioContext) === 'function'; }

    _ensure() {
        if (this.ctx) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        this.ctx = ctx;
        this.master = ctx.createGain();
        this.master.gain.value = 0;
        const comp = ctx.createDynamicsCompressor();
        this.master.connect(comp);
        comp.connect(ctx.destination);
        this.dry = ctx.createGain();
        this.dry.connect(this.master);
        this.reverb = ctx.createConvolver();
        this.reverb.buffer = makeImpulse(ctx);
        this.reverb.connect(this.master);
    }

    /** À appeler depuis un geste de l'utilisateur (clic, touche) : exigé par les navigateurs. */
    start(mood) {
        if (!this.supported) return;
        this._ensure();
        clearTimeout(this._suspendTimer);
        this.running = true;
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        this._ramp(this.volume * 0.6, 1.5);
        this.setMood(mood, true);
    }

    stop() {
        if (!this.ctx || !this.running) return;
        this.running = false;
        this._ramp(0, 0.8);
        clearTimeout(this._suspendTimer);
        this._suspendTimer = setTimeout(() => { if (!this.running) this.ctx.suspend().catch(() => {}); }, 1000);
    }

    setVolume(v) {
        this.volume = v;
        if (this.ctx && this.running) this._ramp(v * 0.6, 0.3);
    }

    setMood(mood, immediate = false) {
        if (!this.ctx || !PROFILES[mood] || (mood === this.mood && this.layer)) return;
        this.mood = mood;
        const old = this.layer;
        const next = new Layer(this, mood);
        const fade = immediate && !old ? 2 : 5;
        next.fade(1, fade);
        if (old) { old.fade(0, fade); old.dispose(fade + 4); }
        this.layer = next;
    }

    /** Arrêt complet (sortie du livre) : libère les ressources audio. */
    shutdown() {
        this.stop();
        if (this.layer) { this.layer.fade(0, 0.8); this.layer.dispose(1); this.layer = null; }
        this.mood = null;
    }

    _ramp(to, seconds) {
        const g = this.master.gain, now = this.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(to, now + seconds);
    }
}
