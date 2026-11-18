// Executes only the approved packets present when the job starts.
const MAX_TIMER_DELAY = 2_147_483_647;

function parseStartTime(value) {
  if (value === undefined) return 0;
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/);
  const time = match && Date.parse(value);
  const calendarDay = match && new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (!Number.isFinite(time) || match[4] === '24' || calendarDay.getUTCDate() !== Number(match[3])) {
    throw Error('Planned start must be a valid ISO timestamp with an explicit time zone');
  }
  return time;
}

export class QueueRunner {
  constructor(workflow, {setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now()} = {}) {
    this.w = workflow;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.active = false;
    this.timer = null;
    this.job = null;
    this.lastError = null;
    this.generation = 0;
  }

  status() {
    return {active: this.active, job: this.job, lastError: this.lastError, nextAt: this.nextAt ?? null};
  }

  start({notBefore} = {}) {
    if (this.active) return this.status();
    if (this.w.running || this.w.checkingCompatibility) throw Error('Wait for previous mailbox operation to settle');
    const startAt = parseStartTime(notBefore);
    const queued = this.w.state.queue.filter(q => q.status === 'queued');
    if (!queued.length) throw Error('No approved queued packets');
    this.ids = new Set(queued.map(q => q.id));
    this.w.resume({notBefore: startAt, allowedIds: this.ids});
    this.active = true;
    this.job = 'job_' + this.now() + '_' + (++this.generation);
    this.lastError = null;
    this.schedule(Math.max(startAt, queued[0].notBefore ?? 0, this.w.state.nextAllowedAt ?? 0, this.now()));
    return this.status();
  }

  schedule(at) {
    const job = this.job;
    this.nextAt = at;
    this.timer = this.setTimer(() => this.step(job), Math.min(MAX_TIMER_DELAY, Math.max(0, at - this.now())));
  }

  async step(job) {
    if (!this.active || job !== this.job) return;
    this.timer = null;
    if (this.nextAt > this.now()) {
      this.schedule(this.nextAt);
      return;
    }
    try {
      const result = await this.w.tick([...this.ids]);
      if (!this.active || job !== this.job) return;
      if (result.status === 'paused_or_busy' && !this.w.state.paused) {
        throw Error('Mailbox is busy; restart the queue after the current operation settles');
      }
      const next = this.w.state.queue.find(q => q.status === 'queued' && this.ids.has(q.id));
      if (this.w.state.paused || result.status === 'empty' || !next) {
        this.active = false;
        this.nextAt = null;
        return;
      }
      this.schedule(Math.max(next.notBefore ?? 0, this.w.state.nextAllowedAt ?? 0, this.now()));
    } catch (error) {
      if (!this.active || job !== this.job) return;
      this.lastError = error.message;
      this.stop();
      if (!this.w.closed) {
        this.w.state.runnerLastError = error.message;
        this.w.save();
      }
    }
  }

  stop() {
    this.active = false;
    this.nextAt = null;
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (!this.w.closed) this.w.pause();
    return this.status();
  }
}
