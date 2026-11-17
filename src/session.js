// session.js - experiment settings chosen in the start menu + the in-world clock.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const Session = {
  mode: 'actions',      // 'actions' = predefined actions, 'free' = free will
  people: 1,            // 1 = solo, 2 = with another person
  needs: true,          // hunger & tiredness on/off
  death: false,         // can die when health reaches 0
  // Method (for reproducible experiments)
  research: true,       // neutral prompts: no personality, no hints, no forced replies
  temperature: 0.7,     // sampling temperature for decisions
  seed: Math.floor(Math.random() * 1e6),   // passed to the model + used for the body's random choices
  clockMs: 0,           // in-world date/time (ms since epoch, local time)
  clockRate: 60,        // in-world seconds per game second
  saveName: '',
  pendingLoad: null,

  ensureClock() {
    if (!this.clockMs) {
      const d = new Date();
      d.setHours(8, 0, 0, 0);
      this.clockMs = d.getTime();
    }
  },

  // "2026-12-25", "14:30" -> true if valid
  setDateTime(dateStr, timeStr) {
    const dm = /^\s*(\d{1,4})-(\d{1,2})-(\d{1,2})\s*$/.exec(dateStr);
    const tm = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(timeStr);
    if (!dm || !tm) return false;
    const [y, mo, d, h, mi] = [+dm[1], +dm[2], +dm[3], +tm[1], +tm[2]];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return false;
    this.clockMs = new Date(y, mo - 1, d, h, mi, 0).getTime();
    return true;
  },

  date() { return new Date(this.clockMs); },
  dateString() {
    const d = this.date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  timeString() {
    const d = this.date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },
  // "Sunday, 15 November 2026, 09:00"
  dateTimeText() {
    const d = this.date();
    return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${this.timeString()}`;
  },
  hour() {
    const d = this.date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  },

  // What the light looks like, in words (given to the AI every turn).
  daylightText() {
    const h = this.hour();
    if (h < 4.5 || h >= 21) return 'It is night. It is dark; only the moon gives a little light.';
    if (h < 6) return 'It is before dawn. The sky is starting to get lighter.';
    if (h < 7.5) return 'It is early morning. The sun is rising.';
    if (h < 11.5) return 'It is morning. The sun is up and it is bright.';
    if (h < 14) return 'It is around midday. The sun is high.';
    if (h < 17) return 'It is afternoon.';
    if (h < 19) return 'It is evening. The sun is setting and the light is turning orange.';
    return 'It is dusk. It is getting dark.';
  },
};

export function fmtTime(t) {
  return `${Math.floor(t / 60)}:${String(Math.floor(t) % 60).padStart(2, '0')}`;
}
