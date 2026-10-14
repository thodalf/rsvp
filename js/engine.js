// Moteur RSVP : cadence d'affichage des mots, navigation, temps restant.
//
// - Minuterie à correction de dérive : chaque échéance est calculée depuis la précédente,
//   pas depuis "maintenant", donc la vitesse réelle reste exacte même si le navigateur traîne.
// - La durée de base est normalisée par le poids moyen du livre : avec les pauses naturelles,
//   la vitesse affichée (mots/min) reste la vitesse réellement obtenue.

import { FLAG_SENTENCE_START, FLAG_PARAGRAPH_END, indexAtOffset } from './text.js';

const RAMP = [1.8, 1.5, 1.3, 1.15, 1.05];

export class RsvpEngine {
    constructor({ onWord, onState, onEnd }) {
        this.onWord = onWord || (() => {});
        this.onState = onState || (() => {});
        this.onEnd = onEnd || (() => {});
        this.tokens = null;
        this.index = 0;
        this.playing = false;
        this.wpm = 300;
        this.pauses = 1;
        this.rampUp = true;
        this._timer = null;
        this._due = 0;
        this._ramp = 0;
        this._cum = null;
    }

    load(tokens, index = 0) {
        this.pause();
        this.tokens = tokens;
        const n = tokens.words.length;
        this._cum = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) this._cum[i + 1] = this._cum[i] + this._weight(i);
        this.index = Math.max(0, Math.min(index, n - 1));
        this.onWord(this.index);
    }

    get length() { return this.tokens ? this.tokens.words.length : 0; }
    get word() { return this.tokens ? this.tokens.words[this.index] : ''; }
    get offset() { return this.tokens ? this.tokens.offsets[this.index] : 0; }

    _weight(i) {
        return 1 + (this.tokens.weights[i] - 1) * this.pauses;
    }

    /** Durée de base (ms) d'un mot de poids 1, ajustée pour que la moyenne corresponde aux mots/min. */
    _unit() {
        const n = this.length;
        const mean = n ? this._cum[n] / n : 1;
        return 60000 / this.wpm / (mean || 1);
    }

    setWpm(wpm) { this.wpm = wpm; }

    setPauses(p) {
        this.pauses = p;
        if (this.tokens) this.load(this.tokens, this.index);
    }

    play() {
        if (!this.tokens || this.playing) return;
        if (this.index >= this.length - 1) this.index = 0;
        this.playing = true;
        this._ramp = this.rampUp ? 0 : RAMP.length;
        this.onState(true);
        this.onWord(this.index);
        this._due = performance.now() + this._delay(this.index);
        this._schedule();
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        clearTimeout(this._timer);
        this._timer = null;
        this.onState(false);
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    _delay(i) {
        let d = this._weight(i) * this._unit();
        if (this._ramp < RAMP.length) d *= RAMP[this._ramp++];
        return d;
    }

    _schedule() {
        const wait = Math.max(0, this._due - performance.now());
        this._timer = setTimeout(() => this._tick(), wait);
    }

    _tick() {
        if (!this.playing) return;
        if (this.index >= this.length - 1) {
            this.pause();
            this.onEnd();
            return;
        }
        this.index++;
        this.onWord(this.index);
        const now = performance.now();
        // Si l'onglet a été gelé (veille), on repart proprement au lieu d'enchaîner les mots en rafale.
        if (now - this._due > 1000) this._due = now;
        this._due += this._delay(this.index);
        this._schedule();
    }

    seek(index) {
        if (!this.tokens) return;
        this.index = Math.max(0, Math.min(index, this.length - 1));
        if (this.playing) {
            this._ramp = this.rampUp ? 1 : RAMP.length;
            this._due = performance.now() + this._delay(this.index);
            clearTimeout(this._timer);
            this._schedule();
        }
        this.onWord(this.index);
    }

    seekOffset(charOffset) {
        if (this.tokens) this.seek(indexAtOffset(this.tokens.offsets, charOffset));
    }

    seekRatio(r) { this.seek(Math.round(r * (this.length - 1))); }

    stepWord(delta) { this.seek(this.index + delta); }

    sentenceStart(i) {
        const f = this.tokens.flags;
        while (i > 0 && !(f[i] & FLAG_SENTENCE_START)) i--;
        return i;
    }

    /** Phrase précédente / suivante. Reculer depuis le début d'une phrase va à la précédente. */
    stepSentence(delta) {
        if (!this.tokens) return;
        const f = this.tokens.flags;
        let i = this.index;
        if (delta < 0) {
            const start = this.sentenceStart(i);
            i = (i - start <= 1) ? this.sentenceStart(Math.max(0, start - 1)) : start;
        } else {
            i++;
            while (i < this.length - 1 && !(f[i] & FLAG_SENTENCE_START)) i++;
        }
        this.seek(i);
    }

    /** Bornes [début, fin) de la phrase contenant i, pour l'aperçu en pause. */
    sentenceBounds(i) {
        const f = this.tokens.flags;
        const start = this.sentenceStart(i);
        let end = i + 1;
        while (end < this.length && !(f[end] & FLAG_SENTENCE_START)) end++;
        return [start, end];
    }

    isParagraphEnd(i) { return !!(this.tokens.flags[i] & FLAG_PARAGRAPH_END); }

    /** Temps de lecture restant en ms à la vitesse actuelle. */
    remainingMs() {
        if (!this.tokens) return 0;
        return (this._cum[this.length] - this._cum[this.index]) * this._unit();
    }

    get ratio() { return this.length > 1 ? this.index / (this.length - 1) : 0; }
}
