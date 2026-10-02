import { freshState, validateState } from './data.js';

// Persist the state and its revision together so a reload can retry an unfinished save.
export class CloudSync {
  constructor({ fetcher = (...args) => fetch(...args), storage = localStorage, onState, onStatus }) {
    Object.assign(this, { fetcher, storage, onState, onStatus });
    this.user = null; this.record = null; this.busy = false; this.conflict = null;
    this.sequence = 0; this.timer = null; this.authRequired = false; this.localError = false;
  }
  key() { return `boxing-scorecard.v2:${this.user.id}`; }
  status(message) { this.onStatus(message, this); }
  writeLocal() {
    try { this.storage.setItem(this.key(), JSON.stringify(this.record)); this.localError = false; return true; }
    catch { this.localError = true; this.status('Device save failed — export a backup'); return false; }
  }
  async api(path, options = {}) {
    let response;
    try {
      response = await this.fetcher(`/api/${path}`, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10000),
        ...options, headers: { ...(this.user ? { 'X-Scorecard-User': this.user.id } : {}), ...options.headers },
      });
    } catch {
      throw new Error(this.record?.pending && !this.localError ? 'Cloud unavailable — changes saved on device' : 'Cloud unavailable — reconnect to sync');
    }
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 302) {
      this.authRequired = true; throw new Error('Sign in again to sync');
    }
    const body = await response.json();
    if (response.status === 409) return { conflict: true, ...body };
    if (!response.ok) throw new Error(body.error || 'Cloud save unavailable');
    return body;
  }
  async start() {
    try {
      const { user } = await this.api('me');
      this.user = user;
      let cached;
      try { cached = JSON.parse(this.storage.getItem(this.key())); } catch {}
      if (cached) {
        try {
          validateState(cached.state);
          if (!Number.isSafeInteger(cached.revision) || cached.revision < 0) throw new Error();
          this.record = cached;
        } catch { this.status('Device cache unreadable — loading cloud history'); }
      }
      this.record ||= { revision: 0, pending: false, state: freshState() };
      this.onState(this.record.state);
      await this.refresh();
      return true;
    } catch (error) {
      // Only a verified identity can select an account cache. Never guess from a shared browser's last user.
      this.status(this.user ? (this.record?.pending ? 'Cloud unavailable — changes saved on device' : error.message) : error.message);
      return Boolean(this.user);
    }
  }
  save(state) {
    this.record.state = structuredClone(state);
    this.record.pending = true; this.sequence++;
    const saved = this.writeLocal();
    if (!this.conflict && saved) this.status(this.authRequired ? 'Sign in again to sync — saved on device' : 'Sync pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
  async refresh() {
    if (!this.user || this.busy || this.conflict || this.authRequired) return;
    this.busy = true;
    try {
      const remote = await this.api('state');
      validateState(remote.state);
      if (this.record.pending) {
        if (remote.revision !== this.record.revision) {
          this.conflict = remote;
          this.status('Changed on another device — review saves');
        }
      } else if (remote.revision !== this.record.revision) {
        this.record = { ...remote, pending: false };
        this.writeLocal(); this.onState(remote.state);
      }
      if (!this.conflict) this.status(this.localError ? 'Device save failed — export a backup' : this.record.pending ? 'Sync pending' : 'Saved to cloud');
    } catch (error) { this.status(error.message); }
    finally { this.busy = false; }
    if (this.record.pending && !this.conflict) await this.flush();
  }
  async flush() {
    if (!this.user || !this.record?.pending || this.busy || this.conflict || this.authRequired) return;
    this.busy = true;
    const sequence = this.sequence;
    try {
      this.status('Saving to cloud…');
      const result = await this.api('state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: this.record.revision, state: this.record.state }),
      });
      if (result.conflict) {
        validateState(result.state); this.conflict = result;
        this.status('Changed on another device — review saves');
      } else {
        this.record.revision = result.revision;
        this.record.pending = this.sequence !== sequence;
        this.writeLocal();
        this.status(this.localError ? 'Device save failed — export a backup' : this.record.pending ? 'Sync pending' : 'Saved to cloud');
      }
    } catch (error) { this.status(error.message); }
    finally { this.busy = false; }
    if (this.record.pending && !this.conflict && this.sequence !== sequence) {
      clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 100);
    }
  }
  resolve(useCloud) {
    if (!this.conflict) return;
    const remote = this.conflict;
    // Retain a recovery copy whichever version the user chooses.
    try { this.storage.setItem(`${this.key()}:conflict-backup`, JSON.stringify(this.record.state)); }
    catch { throw new Error('Export your device copy before resolving: the browser cannot save a backup.'); }
    this.record.revision = remote.revision;
    if (useCloud) {
      this.record.state = remote.state; this.record.pending = false;
      this.onState(remote.state);
    } else { this.record.pending = true; this.sequence++; }
    this.conflict = null; this.writeLocal();
    this.status(useCloud ? 'Saved to cloud' : 'Sync pending');
    if (!useCloud) this.flush();
  }
}
