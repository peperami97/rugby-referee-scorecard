/**
 * Rugby Referee Scorecard & Match Companion
 * Law-compliant scoring, clock management, sin-bin timers, and export.
 */

const STORAGE_KEY = 'rugby_referee_scorecard_state_v1';

// Default initial state
const defaultState = {
  settings: {
    code: 'union15', // 'union15', 'union7', 'unionU19', 'league'
    halfDuration: 40, // in minutes
    yellowCardDuration: 10, // in minutes
    theme: 'dark'
  },
  meta: {
    date: new Date().toISOString().split('T')[0],
    kickoffTime: '15:00',
    venue: '',
    competition: '',
    referee: '',
    tossWinner: 'home',
    tossChoice: 'kick'
  },
  teams: {
    home: {
      name: 'Home XV',
      color: 'Blue',
      score: 0,
      breakdown: { tries: 0, conversions: 0, penalties: 0, dropGoals: 0, penaltyTries: 0 }
    },
    away: {
      name: 'Away XV',
      color: 'White',
      score: 0,
      breakdown: { tries: 0, conversions: 0, penalties: 0, dropGoals: 0, penaltyTries: 0 }
    }
  },
  period: '1st_half', // '1st_half', 'half_time', '2nd_half', 'full_time', 'extra_time'
  timer: {
    running: false,
    elapsedSeconds: 0, // match clock
    stoppageSeconds: 0,
    stoppageRunning: false
  },
  events: [], // log of scoring & card events
  sinBin: [], // active / past yellow cards
  hia: [],    // head injury / blood bin temporary subs
  frontRow: {
    home: { p1: '', p2: '', p3: '', subs: '' },
    away: { p1: '', p2: '', p3: '', subs: '' },
    uncontested: false
  }
};

let state = JSON.parse(JSON.stringify(defaultState));
let matchInterval = null;
let sinBinInterval = null;

// Sound effects via Web Audio API (no external file dependencies)
class RefereeAudio {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
  }

  playWhistle() {
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(2600, now);
      osc.frequency.exponentialRampToValueAtTime(3200, now + 0.1);
      osc.frequency.exponentialRampToValueAtTime(2400, now + 0.35);

      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.45);
    } catch (e) {
      console.warn('Audio playback error', e);
    }
  }

  playAlert() {
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1108.73, now + 0.15);
      osc.frequency.setValueAtTime(1318.51, now + 0.3);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.65);
    } catch (e) {
      console.warn('Audio playback error', e);
    }
  }
}

const audio = new RefereeAudio();

// Initialize App
function initApp() {
  loadFromStorage();
  setupEventListeners();
  renderAll();
  startSinBinClock();
}

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadFromStorage() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      state = Object.assign({}, defaultState, JSON.parse(saved));
    } catch (e) {
      console.error('Error parsing stored state:', e);
      state = JSON.parse(JSON.stringify(defaultState));
    }
  }
}

// Timer Functions
function toggleClock() {
  audio.init();
  if (state.timer.running) {
    pauseClock();
  } else {
    startClock();
  }
}

function startClock() {
  if (state.timer.running) return;
  state.timer.running = true;
  audio.playWhistle();

  matchInterval = setInterval(() => {
    state.timer.elapsedSeconds++;
    if (state.timer.stoppageRunning) {
      state.timer.stoppageSeconds++;
    }
    renderClock();
    saveToStorage();
  }, 1000);

  renderClockControls();
}

function pauseClock() {
  if (!state.timer.running) return;
  state.timer.running = false;
  clearInterval(matchInterval);
  matchInterval = null;
  audio.playWhistle();
  renderClockControls();
  saveToStorage();
}

function toggleStoppage() {
  state.timer.stoppageRunning = !state.timer.stoppageRunning;
  renderClock();
  saveToStorage();
}

function setPeriod(period) {
  state.period = period;
  if (period === 'half_time' || period === 'full_time') {
    pauseClock();
  } else if (period === '2nd_half') {
    // Standard Rugby Union: 2nd half begins at 40'
    const halfSec = state.settings.halfDuration * 60;
    if (state.timer.elapsedSeconds < halfSec) {
      state.timer.elapsedSeconds = halfSec;
    }
  }
  audio.playWhistle();
  renderAll();
  saveToStorage();
}

function resetClock() {
  if (confirm('Reset match clock to 00:00?')) {
    pauseClock();
    state.timer.elapsedSeconds = 0;
    state.timer.stoppageSeconds = 0;
    state.timer.stoppageRunning = false;
    renderClock();
    saveToStorage();
  }
}

function getCurrentMatchMinute() {
  return Math.floor(state.timer.elapsedSeconds / 60) + 1;
}

// Scoring Logic
function getPointsValue(eventType) {
  const isLeague = state.settings.code === 'league';
  switch (eventType) {
    case 'try':
      return isLeague ? 4 : 5;
    case 'conversion':
      return 2;
    case 'penalty':
      return isLeague ? 2 : 3;
    case 'drop_goal':
      return isLeague ? 1 : 3;
    case 'penalty_try':
      return isLeague ? 4 : 7;
    default:
      return 0;
  }
}

let pendingTryTeam = null;

function recordScore(team, eventType, customPoints = null, scorerNum = '') {
  audio.init();
  const pts = customPoints !== null ? customPoints : getPointsValue(eventType);
  const min = getCurrentMatchMinute();

  state.teams[team].score += pts;

  if (eventType === 'try') state.teams[team].breakdown.tries++;
  if (eventType === 'conversion') state.teams[team].breakdown.conversions++;
  if (eventType === 'penalty') state.teams[team].breakdown.penalties++;
  if (eventType === 'drop_goal') state.teams[team].breakdown.dropGoals++;
  if (eventType === 'penalty_try') state.teams[team].breakdown.penaltyTries++;

  const eventObj = {
    id: Date.now() + Math.random(),
    min: min,
    period: state.period,
    team: team,
    eventType: eventType,
    points: pts,
    scorer: scorerNum,
    homeScore: state.teams.home.score,
    awayScore: state.teams.away.score,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  state.events.unshift(eventObj);
  audio.playWhistle();
  renderAll();
  saveToStorage();

  // If this was a Try, show Conversion Quick-Prompt Modal!
  if (eventType === 'try' && eventType !== 'penalty_try') {
    openConversionModal(team);
  }
}

function openConversionModal(team) {
  pendingTryTeam = team;
  const teamName = state.teams[team].name;
  document.getElementById('convTeamName').innerText = teamName;
  document.getElementById('conversionModal').classList.add('active');
}

function handleConversionDecision(success) {
  document.getElementById('conversionModal').classList.remove('active');
  if (pendingTryTeam) {
    if (success) {
      recordScore(pendingTryTeam, 'conversion', 2);
    } else {
      // Missed conversion log
      const min = getCurrentMatchMinute();
      state.events.unshift({
        id: Date.now() + Math.random(),
        min: min,
        period: state.period,
        team: pendingTryTeam,
        eventType: 'conversion_missed',
        points: 0,
        scorer: '',
        homeScore: state.teams.home.score,
        awayScore: state.teams.away.score,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
      renderTimeline();
      saveToStorage();
    }
  }
  pendingTryTeam = null;
}

function undoLastEvent() {
  if (state.events.length === 0) return;
  const last = state.events[0];
  if (!confirm(`Undo last event: ${formatEventDescription(last)}?`)) return;

  state.events.shift();

  // Recalculate scores from remaining events
  recalculateScoresFromEvents();
  renderAll();
  saveToStorage();
}

function recalculateScoresFromEvents() {
  state.teams.home.score = 0;
  state.teams.home.breakdown = { tries: 0, conversions: 0, penalties: 0, dropGoals: 0, penaltyTries: 0 };
  state.teams.away.score = 0;
  state.teams.away.breakdown = { tries: 0, conversions: 0, penalties: 0, dropGoals: 0, penaltyTries: 0 };

  // Traverse oldest to newest
  const chronological = [...state.events].reverse();
  chronological.forEach(ev => {
    if (ev.points && ev.points > 0 && ev.team) {
      state.teams[ev.team].score += ev.points;
      if (ev.eventType === 'try') state.teams[ev.team].breakdown.tries++;
      if (ev.eventType === 'conversion') state.teams[ev.team].breakdown.conversions++;
      if (ev.eventType === 'penalty') state.teams[ev.team].breakdown.penalties++;
      if (ev.eventType === 'drop_goal') state.teams[ev.team].breakdown.dropGoals++;
      if (ev.eventType === 'penalty_try') state.teams[ev.team].breakdown.penaltyTries++;
    }
    // Update snapshot score
    ev.homeScore = state.teams.home.score;
    ev.awayScore = state.teams.away.score;
  });
}

// Disciplinary & Sin-Bin
function openCardModal(team, cardType) {
  document.getElementById('cardTeamSelect').value = team;
  document.getElementById('cardTypeSelect').value = cardType;
  document.getElementById('cardPlayerNum').value = '';
  document.getElementById('cardReason').value = 'High Tackle';
  document.getElementById('cardModal').classList.add('active');
}

function confirmCard() {
  const team = document.getElementById('cardTeamSelect').value;
  const cardType = document.getElementById('cardTypeSelect').value;
  const player = document.getElementById('cardPlayerNum').value.trim() || 'Unknown';
  const reason = document.getElementById('cardReason').value;
  const min = getCurrentMatchMinute();

  document.getElementById('cardModal').classList.remove('active');

  const binDurationSec = state.settings.yellowCardDuration * 60;

  const cardObj = {
    id: Date.now() + Math.random(),
    team: team,
    player: player,
    cardType: cardType,
    reason: reason,
    minIssued: min,
    secondsLeft: cardType === 'yellow' ? binDurationSec : 0,
    status: 'active'
  };

  state.sinBin.push(cardObj);

  // Add to match timeline
  state.events.unshift({
    id: Date.now() + Math.random(),
    min: min,
    period: state.period,
    team: team,
    eventType: cardType === 'yellow' ? 'yellow_card' : 'red_card',
    points: 0,
    scorer: player,
    detail: reason,
    homeScore: state.teams.home.score,
    awayScore: state.teams.away.score,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  });

  audio.playWhistle();
  renderAll();
  saveToStorage();
}

function startSinBinClock() {
  if (sinBinInterval) clearInterval(sinBinInterval);
  sinBinInterval = setInterval(() => {
    // Only countdown active yellow cards when the match clock is running!
    if (!state.timer.running) return;

    let updated = false;
    state.sinBin.forEach(card => {
      if (card.cardType === 'yellow' && card.status === 'active' && card.secondsLeft > 0) {
        card.secondsLeft--;
        updated = true;
        if (card.secondsLeft === 0) {
          card.status = 'expired';
          audio.playAlert();
        }
      }
    });

    if (updated) {
      renderSinBinBanner();
    }
  }, 1000);
}

function dismissSinBin(cardId) {
  const card = state.sinBin.find(c => c.id === cardId);
  if (card) {
    card.status = 'dismissed';
    renderSinBinBanner();
    saveToStorage();
  }
}

// Rendering
function renderAll() {
  renderHeader();
  renderClock();
  renderClockControls();
  renderScoreboard();
  renderSinBinBanner();
  renderTimeline();
}

function renderHeader() {
  document.getElementById('homeTeamLabel').innerText = state.teams.home.name;
  document.getElementById('awayTeamLabel').innerText = state.teams.away.name;
  document.getElementById('homeColorLabel').innerText = state.teams.home.color;
  document.getElementById('awayColorLabel').innerText = state.teams.away.color;

  const codeNames = {
    'union15': 'Rugby Union 15s',
    'union7': 'Rugby Sevens (7s)',
    'unionU19': 'Rugby Union U19',
    'league': 'Rugby League'
  };
  document.getElementById('codeBadge').innerText = codeNames[state.settings.code] || 'Rugby Union';

  const periodNames = {
    '1st_half': '1st Half',
    'half_time': 'Half Time',
    '2nd_half': '2nd Half',
    'full_time': 'Full Time',
    'extra_time': 'Extra Time'
  };
  document.getElementById('periodBadge').innerText = periodNames[state.period] || 'In Play';
}

function renderClock() {
  const totalSec = state.timer.elapsedSeconds;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const formatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  document.getElementById('clockDigits').innerText = formatted;

  const currentMin = getCurrentMatchMinute();
  document.getElementById('minuteBadge').innerText = `${currentMin}'`;

  // Stoppage time display
  const st = state.timer.stoppageSeconds;
  const stM = Math.floor(st / 60);
  const stS = st % 60;
  const stDisplay = document.getElementById('stoppageTimeDisplay');
  stDisplay.innerText = `+${stM}:${String(stS).padStart(2, '0')}`;
  if (state.timer.stoppageRunning) {
    stDisplay.classList.add('stoppage-active');
  } else {
    stDisplay.classList.remove('stoppage-active');
  }
}

function renderClockControls() {
  const btn = document.getElementById('btnStartClock');
  if (state.timer.running) {
    btn.innerHTML = `<svg width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5zm5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5z"/></svg> Pause`;
    btn.className = 'btn btn-warning btn-lg';
  } else {
    btn.innerHTML = `<svg width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/></svg> Start`;
    btn.className = 'btn btn-primary btn-lg';
  }

  const btnStoppage = document.getElementById('btnStoppage');
  if (state.timer.stoppageRunning) {
    btnStoppage.classList.add('btn-warning');
  } else {
    btnStoppage.classList.remove('btn-warning');
  }
}

function renderScoreboard() {
  document.getElementById('homeScoreDisplay').innerText = state.teams.home.score;
  document.getElementById('awayScoreDisplay').innerText = state.teams.away.score;

  // Breakdown subtexts
  const hb = state.teams.home.breakdown;
  document.getElementById('homeBreakdownText').innerText = `${hb.tries}T • ${hb.conversions}C • ${hb.penalties}PG • ${hb.dropGoals}DG`;

  const ab = state.teams.away.breakdown;
  document.getElementById('awayBreakdownText').innerText = `${ab.tries}T • ${ab.conversions}C • ${ab.penalties}PG • ${ab.dropGoals}DG`;
}

function renderSinBinBanner() {
  const container = document.getElementById('sinBinContainer');
  const list = document.getElementById('sinBinCardsList');

  const activeCards = state.sinBin.filter(c => c.cardType === 'yellow' && c.status !== 'dismissed');

  if (activeCards.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = activeCards.map(c => {
    const isExpired = c.secondsLeft <= 0;
    const teamName = state.teams[c.team].name;
    const mins = Math.floor(c.secondsLeft / 60);
    const secs = c.secondsLeft % 60;
    const timeFormatted = `${mins}:${String(secs).padStart(2, '0')}`;

    return `
      <div class="sinbin-chip ${isExpired ? 'expired' : ''}">
        <span>🟨 [${teamName}] #${c.player}</span>
        <span class="sinbin-countdown">${isExpired ? 'TIME SERVED' : timeFormatted}</span>
        <button class="btn btn-sm btn-secondary" onclick="dismissSinBin(${c.id})">
          ${isExpired ? 'Re-enter ✓' : 'Dismiss'}
        </button>
      </div>
    `;
  }).join('');
}

function renderTimeline() {
  const list = document.getElementById('eventsList');
  if (state.events.length === 0) {
    list.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-muted); font-size: 13px;">No events recorded yet. Kick off to begin!</div>`;
    return;
  }

  list.innerHTML = state.events.map(ev => {
    const teamName = ev.team ? state.teams[ev.team].name : '';
    const desc = formatEventDescription(ev);

    return `
      <div class="event-item">
        <span class="event-min">${ev.min}'</span>
        <span class="event-team" style="color: ${ev.team === 'home' ? 'var(--home-color)' : 'var(--away-color)'}">${teamName}</span>
        <span class="event-desc">${desc}</span>
        <span class="event-score">${ev.homeScore} - ${ev.awayScore}</span>
      </div>
    `;
  }).join('');
}

function formatEventDescription(ev) {
  const playerPrefix = ev.scorer ? `(#${ev.scorer}) ` : '';
  switch (ev.eventType) {
    case 'try':
      return `🏉 <strong>TRY</strong> ${playerPrefix}+${ev.points} pts`;
    case 'conversion':
      return `👟 <strong>Conversion</strong> ${playerPrefix}+2 pts`;
    case 'conversion_missed':
      return `❌ Conversion Missed`;
    case 'penalty':
      return `🎯 <strong>Penalty Goal</strong> ${playerPrefix}+${ev.points} pts`;
    case 'drop_goal':
      return `⚡ <strong>Drop Goal</strong> ${playerPrefix}+${ev.points} pts`;
    case 'penalty_try':
      return `⭐ <strong>PENALTY TRY</strong> +${ev.points} pts (No kick)`;
    case 'yellow_card':
      return `🟨 <strong>Yellow Card</strong> Player #${ev.scorer} &mdash; ${ev.detail || 'Foul Play'}`;
    case 'red_card':
      return `🟥 <strong>RED CARD</strong> Player #${ev.scorer} &mdash; ${ev.detail || 'Foul Play'}`;
    default:
      return `${ev.eventType} (+${ev.points})`;
  }
}

// WhatsApp / Portal Match Summary
function copyMatchReportText() {
  const h = state.teams.home;
  const a = state.teams.away;
  const dateStr = state.meta.date || new Date().toISOString().split('T')[0];

  let text = `🏉 RUGBY MATCH REPORT\n`;
  text += `Competition: ${state.meta.competition || 'Senior Match'}\n`;
  text += `Date: ${dateStr} | Venue: ${state.meta.venue || 'Home'}\n`;
  text += `Referee: ${state.meta.referee || 'Official'}\n\n`;
  text += `FULL TIME: ${h.name} ${h.score} - ${a.score} ${a.name}\n`;
  text += `Breakdown:\n`;
  text += `• ${h.name}: ${h.breakdown.tries}T, ${h.breakdown.conversions}C, ${h.breakdown.penalties}PG, ${h.breakdown.dropGoals}DG\n`;
  text += `• ${a.name}: ${a.breakdown.tries}T, ${a.breakdown.conversions}C, ${a.breakdown.penalties}PG, ${a.breakdown.dropGoals}DG\n\n`;

  // Disciplinary
  const yellowCards = state.events.filter(e => e.eventType === 'yellow_card');
  const redCards = state.events.filter(e => e.eventType === 'red_card');
  if (yellowCards.length > 0 || redCards.length > 0) {
    text += `DISCIPLINARY:\n`;
    yellowCards.forEach(c => text += `• 🟨 ${c.min}' ${state.teams[c.team].name} #${c.scorer} (${c.detail})\n`);
    redCards.forEach(c => text += `• 🟥 ${c.min}' ${state.teams[c.team].name} #${c.scorer} (${c.detail})\n`);
    text += `\n`;
  }

  text += `Timeline Summary:\n`;
  const chronological = [...state.events].reverse();
  chronological.forEach(e => {
    if (e.eventType !== 'conversion_missed') {
      text += `${e.min}' [${state.teams[e.team]?.name || ''}] ${e.eventType.toUpperCase()} (${e.homeScore}-${e.awayScore})\n`;
    }
  });

  navigator.clipboard.writeText(text).then(() => {
    alert('Match Report copied to clipboard! Ready to paste into WhatsApp, email, or society portal.');
  }).catch(() => {
    prompt('Copy match report below:', text);
  });
}

// Modal and Setup Listeners
function setupEventListeners() {
  document.getElementById('btnStartClock').addEventListener('click', toggleClock);
  document.getElementById('btnStoppage').addEventListener('click', toggleStoppage);
  document.getElementById('btnResetClock').addEventListener('click', resetClock);
  document.getElementById('btnUndo').addEventListener('click', undoLastEvent);
  document.getElementById('btnCopyReport').addEventListener('click', copyMatchReportText);

  // Match settings modal
  document.getElementById('btnMatchSetup').addEventListener('click', () => {
    document.getElementById('setupHomeName').value = state.teams.home.name;
    document.getElementById('setupAwayName').value = state.teams.away.name;
    document.getElementById('setupHomeColor').value = state.teams.home.color;
    document.getElementById('setupAwayColor').value = state.teams.away.color;
    document.getElementById('setupVenue').value = state.meta.venue;
    document.getElementById('setupComp').value = state.meta.competition;
    document.getElementById('setupRef').value = state.meta.referee;
    document.getElementById('setupCode').value = state.settings.code;
    document.getElementById('setupDuration').value = state.settings.halfDuration;
    document.getElementById('setupModal').classList.add('active');
  });

  document.getElementById('btnSaveSetup').addEventListener('click', () => {
    state.teams.home.name = document.getElementById('setupHomeName').value.trim() || 'Home XV';
    state.teams.away.name = document.getElementById('setupAwayName').value.trim() || 'Away XV';
    state.teams.home.color = document.getElementById('setupHomeColor').value.trim() || 'Blue';
    state.teams.away.color = document.getElementById('setupAwayColor').value.trim() || 'White';
    state.meta.venue = document.getElementById('setupVenue').value.trim();
    state.meta.competition = document.getElementById('setupComp').value.trim();
    state.meta.referee = document.getElementById('setupRef').value.trim();

    state.settings.code = document.getElementById('setupCode').value;
    state.settings.halfDuration = parseInt(document.getElementById('setupDuration').value, 10) || 40;
    state.settings.yellowCardDuration = state.settings.code === 'union7' ? 2 : 10;

    document.getElementById('setupModal').classList.remove('active');
    renderAll();
    saveToStorage();
  });

  // Modal dismiss buttons
  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.target.closest('.modal-overlay').classList.remove('active');
    });
  });

  // Period selectors
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-period');
      setPeriod(p);
    });
  });

  // Theme selector
  document.getElementById('themeSelect').addEventListener('change', (e) => {
    const val = e.target.value;
    state.settings.theme = val;
    document.body.setAttribute('data-theme', val);
    saveToStorage();
  });

  if (state.settings.theme) {
    document.body.setAttribute('data-theme', state.settings.theme);
    document.getElementById('themeSelect').value = state.settings.theme;
  }
}

// Window load init
window.addEventListener('DOMContentLoaded', initApp);
