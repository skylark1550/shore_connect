let timetableData = null;
let atomicTimeOffset = 0;
let atomicTimeSynced = false;
let statusDisplayMode = true;

// Add this near the top of the file after other declarations
function initThemeVariables() {
  // Ensure CSS variables are defined
  const root = document.documentElement;
  if (!root.style.getPropertyValue('--accent')) {
    root.style.setProperty('--accent', '#ff9800');
    root.style.setProperty('--success', '#27ae60');
    root.style.setProperty('--muted', '#64748b');
    root.style.setProperty('--border', '#e2e8f0');
    root.style.setProperty('--heading-accent', '#ff9800');
    root.style.setProperty('--text', '#0f172a');
  }
}

// Call this when DOM is ready
document.addEventListener('DOMContentLoaded', initThemeVariables);

/* ---------------- NORMALIZATION ---------------- */
function normalizeName(str) {
  return str.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

let stationLookup = {};
let stopsByStation = {};
let stopsByTrain = {};

const MIN_LAYOVER_SECONDS = 10 * 60;
let liveBoardInterval = null;
let liveBoardRebuildInterval = null;
let mapRefreshInterval = null;
let currentTrainPositions = [];
let mapScrollPosition = 0;
let mapZoomLevel = 1;

/* ---------------- ATOMIC CLOCK SYNC ---------------- */
let atomicGMT12Time = null; // Store the actual atomic GMT+12 time

async function syncAtomicTime() {
  const clockElement = document.getElementById('liveClock');
  if (clockElement) {
    clockElement.textContent = 'GMT+12: Syncing time...';
  }
  
  try {
    const timeData = await fetchAtomicTime();
    
    if (timeData) {
      // Parse the UTC time from the API
      const atomicUTC = new Date(timeData.datetime || timeData.utc_datetime);
      
      // Convert to GMT+12 by adding 12 hours
      atomicGMT12Time = new Date(atomicUTC.getTime() + (12 * 60 * 60 * 1000));
      
      // Store the timestamp when we synced
      atomicTimeSynced = true;
      atomicTimeSyncTimestamp = Date.now();
      
      console.log(`Atomic time synced successfully`);
      console.log(`Atomic UTC: ${atomicUTC.toISOString()}`);
      console.log(`Atomic GMT+12: ${atomicGMT12Time.toISOString()}`);
      
      if (clockElement) {
        clockElement.textContent = 'GMT+12: Time synced ✓';
        setTimeout(() => {
          updateClock();
        }, 1000);
      }
    } else {
      throw new Error('No time data received');
    }
  } catch (error) {
    console.warn('Failed to sync atomic time:', error);
    atomicTimeSynced = false;
    if (clockElement) {
      clockElement.textContent = 'GMT+12: Sync failed - retrying...';
      // Retry sync after 10 seconds
      setTimeout(() => syncAtomicTime(), 10000);
    }
  }
}

async function fetchAtomicTime() {
  // Try multiple APIs in order of preference - all return UTC time
  const apis = [
    {
      url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
      parser: (data) => data
    },
    {
      url: 'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
      parser: (data) => ({ datetime: data.dateTime })
    },
    {
      url: 'http://worldtimeapi.org/api/timezone/Etc/UTC',
      parser: (data) => data
    }
  ];
  
  for (const api of apis) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(api.url, { 
        signal: controller.signal,
        cache: 'no-cache'
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        return api.parser(data);
      }
    } catch (error) {
      console.warn(`Failed to fetch from ${api.url}:`, error.message);
      continue;
    }
  }
  
  return null;
}

/* ---------------- GMT+12 CLOCK ---------------- */
let atomicTimeSyncTimestamp = 0;

function getGMT12Time() {
  if (atomicTimeSynced && atomicGMT12Time) {
    // Calculate elapsed time since last sync
    const elapsedMs = Date.now() - atomicTimeSyncTimestamp;
    // Add elapsed time to the synced atomic GMT+12 time
    return new Date(atomicGMT12Time.getTime() + elapsedMs);
  } else {
    // Fallback: use local time converted to GMT+12
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
    const gmt12Ms = utcMs + (12 * 60 * 60 * 1000);
    return new Date(gmt12Ms);
  }
}

function getGMT12Seconds() {
  const gmt12 = getGMT12Time();
  return gmt12.getHours() * 3600 + gmt12.getMinutes() * 60 + gmt12.getSeconds();
}

function updateClock() {
  const clockElement = document.getElementById('liveClock');
  if (!clockElement) return;
  
  const gmt12 = getGMT12Time();
  const hours = String(gmt12.getHours()).padStart(2, '0');
  const minutes = String(gmt12.getMinutes()).padStart(2, '0');
  const seconds = String(gmt12.getSeconds()).padStart(2, '0');
  const year = gmt12.getFullYear();
  const month = String(gmt12.getMonth() + 1).padStart(2, '0');
  const day = String(gmt12.getDate()).padStart(2, '0');
  
  const timeString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  const syncStatus = atomicTimeSynced ? '⚛' : '⏳';
  clockElement.textContent = `GMT+12: ${timeString} ${syncStatus}`;
  
  // Update live departures countdowns if a station board is active
  if (typeof updateLiveDepartures === 'function') {
    updateLiveDepartures();
  }
}

function updateLiveDepartures() {
  const liveRows = document.querySelectorAll('.live-departure-row');
  if (liveRows.length === 0) return;
  
  const currentSeconds = getGMT12Seconds();
  
  liveRows.forEach(row => {
    const departureTime = row.dataset.departureTime;
    const departureSeconds = toSeconds(departureTime);
    const countdownEl = row.querySelector('.countdown');
    const statusBadge = row.querySelector('.status-badge');
    
    if (!countdownEl) return;
    
    let secondsUntilDeparture = departureSeconds - currentSeconds;
    
    // Handle overnight: if more than 12h negative it's "yesterday's" train shown as tomorrow
    if (secondsUntilDeparture < -43200) secondsUntilDeparture += 86400;
    // If still more than 20h away, it's actually a future departure beyond our window — skip styling
    if (secondsUntilDeparture > 72000) return;
    
    // Remove all animation classes first
    row.classList.remove('status-departing', 'status-imminent', 'status-boarding', 'status-ontime', 'status-departed');
    countdownEl.style.animation = 'none';
    
    // Only update the countdown cell and row class here.
    // Status badge is owned exclusively by updateLiveBoardStatuses to avoid flicker.
    if (secondsUntilDeparture <= -60) {
      countdownEl.textContent = 'Departed';
      countdownEl.style.color = '#95a5a6';
      countdownEl.style.fontWeight = 'normal';
      row.classList.add('status-departed');
    } else if (secondsUntilDeparture <= 0) {
      countdownEl.textContent = 'Departing now';
      countdownEl.style.color = '#e74c3c';
      countdownEl.style.fontWeight = 'bold';
      row.classList.add('status-departing');
    } else if (secondsUntilDeparture < 60) {
      countdownEl.textContent = `${secondsUntilDeparture}s`;
      countdownEl.style.color = '#e74c3c';
      countdownEl.style.fontWeight = 'bold';
      row.classList.add('status-imminent');
    } else if (secondsUntilDeparture < 300) {
      const minutes = Math.floor(secondsUntilDeparture / 60);
      const secs = secondsUntilDeparture % 60;
      countdownEl.textContent = `${minutes}m ${secs}s`;
      countdownEl.style.color = '#e67e22';
      countdownEl.style.fontWeight = 'bold';
      row.classList.add('status-boarding');
    } else if (secondsUntilDeparture < 3600) {
      const minutes = Math.floor(secondsUntilDeparture / 60);
      countdownEl.textContent = `${minutes}m`;
      countdownEl.style.color = '#27ae60';
      countdownEl.style.fontWeight = 'normal';
      row.classList.add('status-ontime');
    } else {
      const hours = Math.floor(secondsUntilDeparture / 3600);
      const minutes = Math.floor((secondsUntilDeparture % 3600) / 60);
      countdownEl.textContent = `${hours}h ${minutes}m`;
      countdownEl.style.color = '#3498db';
      countdownEl.style.fontWeight = 'normal';
      row.classList.add('status-ontime');
    }
  });
}

/* ---------------- LOAD DATA ---------------- */
// Replace the fetch call at the top with this safer version:
fetch("data/shore_connect_export.json")
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then(json => {
    console.log('Data loaded successfully');
    timetableData = json;

    // Validate required data structures
    if (!timetableData.timetable) timetableData.timetable = [];
    if (!timetableData.stations) timetableData.stations = [];
    if (!timetableData.trains) timetableData.trains = [];

    timetableData.timetable.forEach(stop => {
      stop.stationId = String(stop.stationId || normalizeName(stop.station));
      stop.trainId = String(stop.trainId);
      if (stop.departure && stop.departure.length === 5) stop.departure += ":00";
      if (stop.arrival && stop.arrival.length === 5) stop.arrival += ":00";
    });

    timetableData.stations.forEach(st => {
      st.stationId = String(st.stationId || normalizeName(st.name));
      stationLookup[st.stationId] = st;
    });

    indexTimetable();
    mergeAliasStations();
    preassignAllPlatforms();
    populateStationDropdowns();
    
    // Start the clock immediately with local time
    if (typeof updateClock === 'function') {
      updateClock();
      setInterval(updateClock, 1000);
    }
    
    // Sync with atomic time in the background
    if (typeof syncAtomicTime === 'function') {
      syncAtomicTime().then(() => {
        console.log('Initial atomic time sync complete');
        setInterval(syncAtomicTime, 30 * 60 * 1000);
      }).catch(err => console.warn('Atomic time sync failed:', err));
    }
    
    // Initialize admin system after data is ready
    if (typeof initAdminSystem === 'function') {
      setTimeout(() => initAdminSystem(), 500);
    }
    
    // Initialize user system after data is ready
    if (typeof initUserSystem === 'function') {
      setTimeout(() => initUserSystem(), 800);
    }
  })
  .catch(err => {
    console.error("Data load failed:", err);
    const resultsDiv = document.getElementById("results");
    if (resultsDiv) {
      resultsDiv.innerHTML = `<div class="error-message">Failed to load timetable data: ${err.message}. Please check that data/shore_connect_export.json exists and is valid.</div>`;
    }
  });

/* ---------------- INDEXING ---------------- */
function indexTimetable() {
  stopsByStation = {};
  stopsByTrain = {};

  timetableData.timetable.forEach(s => {
    if (!stopsByStation[s.stationId]) stopsByStation[s.stationId] = [];
    if (!stopsByTrain[s.trainId]) stopsByTrain[s.trainId] = [];

    stopsByStation[s.stationId].push(s);
    stopsByTrain[s.trainId].push(s);
  });

  Object.values(stopsByStation).forEach(arr =>
    arr.sort((a, b) => toSeconds(a.departure || a.arrival) - toSeconds(b.departure || b.arrival))
  );

  Object.values(stopsByTrain).forEach(arr =>
    arr.sort((a, b) => a.sequence - b.sequence)
  );
}

/* ---------------- STATION ALIASES ---------------- */
let stationAliases   = {}; // stationId -> canonical display name
let stationIdAliases = {}; // stationId -> [all stationIds in the same physical group]

function samePhysicalStation(a, b) {
  if (a === b) return true;
  const groupA = stationIdAliases[a];
  const groupB = stationIdAliases[b];
  
  if (groupA && groupB) {
    return groupA[0] === groupB[0];
  }
  if (groupA) {
    return groupA.includes(b);
  }
  if (groupB) {
    return groupB.includes(a);
  }
  return false;
}

function allAliasIds(stationId) {
  return stationIdAliases[stationId] || [stationId];
}

function mergeAliasStations() {
  const aliasGroups = [
    { names: ['Set (Looped)', 'Set'], canonical: 'Set / Set (Looped)' }
  ];

  aliasGroups.forEach(group => {
    const members = timetableData.stations.filter(st =>
      group.names.some(n => st.name.trim() === n.trim())
    );
    if (members.length < 2) return;

    // IMPORTANT: DON'T merge stops - keep them separate but mark as aliases
    // Just store the alias mapping without modifying stopsByStation
    const memberIds = members.map(st => st.stationId);
    members.forEach(st => {
      // Don't modify stopsByStation - keep original stops
      stationAliases[st.stationId] = group.canonical;
      stationIdAliases[st.stationId] = memberIds;
    });

    console.log(`Alias created for: [${members.map(s=>s.name).join(', ')}] → ${group.canonical}`);
  });
}

/* ---------------- PLATFORM PRE-ASSIGNMENT ---------------- */
// Assign platforms for every stop in the timetable once, sorted by departure time,
// so that earlier trains always claim platforms before later ones. This prevents
// the live board render order from producing inconsistent or conflicting assignments.
function preassignAllPlatforms() {
  const allStops = [...timetableData.timetable];
  allStops.sort((a, b) =>
    toSeconds(a.departure || a.arrival) - toSeconds(b.departure || b.arrival)
  );
  allStops.forEach(stop => getPlatformForStop(stop));
  console.log(`Pre-assigned platforms for ${allStops.length} stops`);
}

/* ---------------- MODE TOGGLE ---------------- */
const stationModeBtn = document.getElementById("stationMode");
const trainModeBtn   = document.getElementById("trainMode");
const boardModeBtn   = document.getElementById("boardMode");
const liveBoardBtn   = document.getElementById("liveBoardMode");
const routeMapBtn    = document.getElementById("routeMapMode");
const statsBtn       = document.getElementById("statsMode");
const liveMapBtn     = document.getElementById("liveMapMode");  // ADD THIS
const stationSearch  = document.getElementById("stationSearch");
const trainSearch    = document.getElementById("trainSearch");
const boardSearch    = document.getElementById("boardSearch");
const liveBoardSearch = document.getElementById("liveBoardSearch");
const routeMapSearch  = document.getElementById("routeMapSearch");
const statsSearch     = document.getElementById("statsSearch");
const liveMapSearch   = document.getElementById("liveMapSearch"); // ADD THIS

// Add this function before setMode
function stopLiveMap() {
  if (mapRefreshInterval) {
    clearInterval(mapRefreshInterval);
    mapRefreshInterval = null;
  }
}

function setMode(active) {
  // Stop map refresh when switching away from map mode
  if (active.btn !== liveMapBtn && mapRefreshInterval) {
    stopLiveMap();
  }
  
  [stationModeBtn, trainModeBtn, boardModeBtn, liveBoardBtn, routeMapBtn, statsBtn, liveMapBtn].forEach(b => b.classList.remove("active"));
  [stationSearch, trainSearch, boardSearch, liveBoardSearch, routeMapSearch, statsSearch, liveMapSearch].forEach(el => el.classList.add("hidden"));
  
  active.btn.classList.add("active");
  active.panel.classList.remove("hidden");
  
  if (active.onActivate) active.onActivate();
}

stationModeBtn.onclick = () => setMode({ btn: stationModeBtn, panel: stationSearch });
trainModeBtn.onclick   = () => setMode({ btn: trainModeBtn,   panel: trainSearch });
boardModeBtn.onclick   = () => setMode({ btn: boardModeBtn,   panel: boardSearch });
liveBoardBtn.onclick   = () => setMode({ btn: liveBoardBtn,   panel: liveBoardSearch });
routeMapBtn.onclick    = () => setMode({ btn: routeMapBtn,    panel: routeMapSearch, onActivate: renderRouteMap });
statsBtn.onclick       = () => setMode({ btn: statsBtn,       panel: statsSearch });
liveMapBtn.onclick     = () => setMode({ btn: liveMapBtn,     panel: liveMapSearch, onActivate: startLiveMap }); // ADD THIS LINE

/* ---------------- STATIONS ---------------- */
function populateStationDropdowns() {
  const from  = document.getElementById("fromStation");
  const to    = document.getElementById("toStation");
  const board = document.getElementById("boardStation");
  const liveBoard = document.getElementById("liveBoardStation");
  const stats = document.getElementById("statsStation");

  from.innerHTML = '';
  to.innerHTML = '';
  board.innerHTML = '';
  liveBoard.innerHTML = '';
  stats.innerHTML = '';

  const seenCanonical = new Set();
  timetableData.stations.forEach(st => {
    const canonical = stationAliases[st.stationId];
    if (canonical) {
      if (seenCanonical.has(canonical)) return;
      seenCanonical.add(canonical);
      from.add(new Option(canonical, st.stationId));
      to.add(new Option(canonical, st.stationId));
      board.add(new Option(canonical, st.stationId));
      liveBoard.add(new Option(canonical, st.stationId));
      stats.add(new Option(canonical, st.stationId));
    } else {
      from.add(new Option(st.name, st.stationId));
      to.add(new Option(st.name, st.stationId));
      board.add(new Option(st.name, st.stationId));
      liveBoard.add(new Option(st.name, st.stationId));
      stats.add(new Option(st.name, st.stationId));
    }
  });
}

/* ---------------- HELPER: CHECK IF TRAIN TERMINATES AT THIS STATION ---------------- */
function isTerminatingStop(stop, trainId) {
  const trainStops = stopsByTrain[trainId];
  if (!trainStops || trainStops.length === 0) return false;
  
  // Find the last stop of this train
  const lastStop = trainStops[trainStops.length - 1];
  
  // If this stop is the last stop (or an alias of it), the train terminates here
  if (samePhysicalStation(stop.stationId, lastStop.stationId)) {
    return true;
  }
  
  return false;
}

function isOriginatingStop(stop, trainId) {
  const trainStops = stopsByTrain[trainId];
  if (!trainStops || trainStops.length === 0) return false;
  
  // Find the first stop of this train
  const firstStop = trainStops[0];
  
  // If this stop is the first stop (or an alias of it), the train starts here
  if (samePhysicalStation(stop.stationId, firstStop.stationId)) {
    return true;
  }
  
  return false;
}

/* ---------------- TIME HELPERS ---------------- */
function toSeconds(t, trainId) {
  if (!t) return 0;
  const [h = 0, m = 0, s = 0] = t.split(":").map(Number);
  let seconds = h * 3600 + m * 60 + s;
  
  // Apply active delays if trainId is provided
  if (trainId && window.trainDelays) {
    const activeDelays = Object.values(window.trainDelays)
      .filter(d => d.trainId === trainId && d.active);
    
    if (activeDelays.length > 0) {
      const totalDelayMinutes = activeDelays.reduce((sum, d) => sum + d.minutes, 0);
      seconds += (totalDelayMinutes * 60);
    }
  }
  
  return seconds;
}

function calculateDuration(start, end) {
  const d = calculateDurationSeconds(start, end);
  return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
}

function calculateDurationSeconds(start, end) {
  let s = toSeconds(start);
  let e = toSeconds(end);
  // On a ring line services can cross midnight; add 86400 if end appears earlier
  if (e < s) e += 86400;
  return e - s;
}

// Compute duration by walking the actual stop sequence between fromStop and toStop,
// accumulating seconds segment-by-segment and adding 86400 whenever a segment
// crosses midnight. This correctly handles journeys longer than 24 hours
// (e.g. a full ring-line loop). fromStop, toStop, trainStops are optional;
// without them falls back to a simple clock-diff (fine for single-day legs).
function journeyDurationSeconds(departureTime, arrivalTime, absoluteDep, fromStop, toStop, trainStops) {
  if (fromStop && toStop && trainStops) {
    const fromSeq = fromStop.sequence;
    const toSeq   = toStop.sequence;
    const segment = trainStops
      .filter(s => s.sequence >= fromSeq && s.sequence <= toSeq)
      .sort((a, b) => a.sequence - b.sequence);
    if (segment.length >= 2) {
      let total = 0;
      for (let i = 0; i < segment.length - 1; i++) {
        const cur  = toSeconds(segment[i].departure  || segment[i].arrival);
        const next = toSeconds(segment[i+1].arrival  || segment[i+1].departure);
        let diff = next - cur;
        if (diff < 0) diff += 86400; // segment crosses midnight
        total += diff;
      }
      return total;
    }
  }
  // Fallback: simple clock-time diff, wraps midnight once
  const depSec = toSeconds(departureTime);
  let arrSec   = toSeconds(arrivalTime);
  if (arrSec < depSec) arrSec += 86400;
  return arrSec - depSec;
}

function formatLayover(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

/* ---------------- PLATFORM GENERATOR ---------------- */
const platformAssignments = {}; // trainId_stationId -> platform number
// platformOccupancy[stationId][platform] = [{arrivalSec, departureSec}]
const platformOccupancy  = {};

// Minimum gap in seconds between one train clearing and the next arriving
// on the same platform (boarding + alighting buffer).
const PLATFORM_TURNAROUND_SEC = 3 * 60; // 3 minutes

function getStationPlatforms(stationId) {
  const station = stationLookup[stationId];
  if (!station) return { total: 8, ranges: {} };
  
  const type = station.type;
  let totalPlatforms;
  let ranges;
  
  switch (type) {
    case 'LTD_EXPRESS':
      totalPlatforms = 32;
      ranges = {
        'LTD_EXPRESS': { CW: [1, 4], CCW: [29, 32] },
        'EXPRESS': { CW: [5, 8], CCW: [25, 28] },
        'LTD_LOCAL': { CW: [9, 12], CCW: [21, 24] },
        'LOCAL': { CW: [13, 16], CCW: [17, 20] }
      };
      break;
    case 'EXPRESS':
      totalPlatforms = 24;
      ranges = {
        'EXPRESS': { CW: [1, 4], CCW: [21, 24] },
        'LTD_LOCAL': { CW: [5, 8], CCW: [17, 20] },
        'LOCAL': { CW: [9, 12], CCW: [13, 16] }
      };
      break;
    case 'LTD_LOCAL':
      totalPlatforms = 16;
      ranges = {
        'LTD_LOCAL': { CW: [1, 4], CCW: [13, 16] },
        'LOCAL': { CW: [5, 8], CCW: [9, 12] }
      };
      break;
    case 'LOCAL':
      totalPlatforms = 8;
      ranges = {
        'LOCAL': { CW: [1, 4], CCW: [5, 8] }
      };
      break;
    default:
      totalPlatforms = 8;
      ranges = {
        'LOCAL': { CW: [1, 4], CCW: [5, 8] }
      };
  }
  
  return { total: totalPlatforms, ranges: ranges };
}

function assignPlatform(trainId, stationId, serviceType, direction, arrivalSec, departureSec) {
  const key = `${trainId}_${stationId}`;

  // Return cached assignment if already resolved
  if (platformAssignments[key] !== undefined) {
    return platformAssignments[key];
  }

  const platformInfo = getStationPlatforms(stationId);
  const serviceRanges = platformInfo.ranges[serviceType];

  // Determine the candidate range for this service type + direction
  let minPlatform, maxPlatform;
  if (serviceRanges && serviceRanges[direction]) {
    [minPlatform, maxPlatform] = serviceRanges[direction];
  } else {
    // Fallback: use full platform range
    minPlatform = 1;
    maxPlatform = platformInfo.total;
  }

  // Ensure the occupancy map exists for this station
  if (!platformOccupancy[stationId]) platformOccupancy[stationId] = {};

  // The window this train occupies the platform.
  // Add the turnaround buffer on both ends so we never schedule two trains
  // closer than PLATFORM_TURNAROUND_SEC on the same platform.
  const windowStart = arrivalSec  - PLATFORM_TURNAROUND_SEC;
  const windowEnd   = departureSec + PLATFORM_TURNAROUND_SEC;

  // Helper: does a given platform have a time conflict with this train?
  function hasConflict(p) {
    const slots = platformOccupancy[stationId][p] || [];
    return slots.some(slot => {
      // Two windows overlap if neither ends before the other starts.
      // Handle midnight wrapping: if either window crosses midnight, check both offsets.
      const conflicts = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
      if (conflicts(windowStart, windowEnd, slot.start, slot.end)) return true;
      // Also check with one day shift in each direction for midnight-crossing trains
      if (conflicts(windowStart + 86400, windowEnd + 86400, slot.start, slot.end)) return true;
      if (conflicts(windowStart, windowEnd, slot.start + 86400, slot.end + 86400)) return true;
      return false;
    });
  }

  // === NEW: Spread trains across all available platforms ===
  
  // First, collect all conflict-free platforms
  const freePlatforms = [];
  for (let p = minPlatform; p <= maxPlatform; p++) {
    if (!hasConflict(p)) {
      freePlatforms.push(p);
    }
  }

  let assigned = null;

  if (freePlatforms.length > 0) {
    // If we have free platforms, pick the one with the lightest load
    // (fewest existing assignments) to spread trains evenly
    let minLoad = Infinity;
    for (const p of freePlatforms) {
      const load = (platformOccupancy[stationId][p] || []).length;
      if (load < minLoad) {
        minLoad = load;
        assigned = p;
      }
    }
    
    // If multiple platforms have the same minimum load, 
    // prefer the highest-numbered one to avoid lower-platform clustering
    const tiedPlatforms = freePlatforms.filter(p => 
      (platformOccupancy[stationId][p] || []).length === minLoad
    );
    if (tiedPlatforms.length > 1) {
      assigned = tiedPlatforms[tiedPlatforms.length - 1]; // Pick highest platform number
    }
  } else {
    // No completely free platforms - find the one with fewest conflicts
    let minConflicts = Infinity;
    for (let p = minPlatform; p <= maxPlatform; p++) {
      const slots = platformOccupancy[stationId][p] || [];
      const conflictCount = slots.filter(slot => {
        const conflicts = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
        return conflicts(windowStart, windowEnd, slot.start, slot.end) ||
               conflicts(windowStart + 86400, windowEnd + 86400, slot.start, slot.end) ||
               conflicts(windowStart, windowEnd, slot.start + 86400, slot.end + 86400);
      }).length;
      
      if (conflictCount < minConflicts) {
        minConflicts = conflictCount;
        assigned = p;
      }
    }
    
    // If tie on minimum conflicts, pick the highest platform
    const tiedPlatforms = [];
    for (let p = minPlatform; p <= maxPlatform; p++) {
      const slots = platformOccupancy[stationId][p] || [];
      const conflictCount = slots.filter(slot => {
        const conflicts = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
        return conflicts(windowStart, windowEnd, slot.start, slot.end) ||
               conflicts(windowStart + 86400, windowEnd + 86400, slot.start, slot.end) ||
               conflicts(windowStart, windowEnd, slot.start + 86400, slot.end + 86400);
      }).length;
      if (conflictCount === minConflicts) {
        tiedPlatforms.push(p);
      }
    }
    if (tiedPlatforms.length > 1) {
      assigned = tiedPlatforms[tiedPlatforms.length - 1]; // Pick highest platform number
    }
  }

  // Fallback: if still no platform assigned, pick the one with fewest trains
  if (assigned === null) {
    let minLoad = Infinity;
    for (let p = minPlatform; p <= maxPlatform; p++) {
      const load = (platformOccupancy[stationId][p] || []).length;
      if (load < minLoad) { 
        minLoad = load; 
        assigned = p; 
      }
    }
    // Pick highest platform among ties
    const tiedPlatforms = [];
    for (let p = minPlatform; p <= maxPlatform; p++) {
      const load = (platformOccupancy[stationId][p] || []).length;
      if (load === minLoad) tiedPlatforms.push(p);
    }
    if (tiedPlatforms.length > 1) {
      assigned = tiedPlatforms[tiedPlatforms.length - 1];
    }
  }

  // Record the assignment and the occupancy window
  platformAssignments[key] = assigned;
  if (!platformOccupancy[stationId][assigned]) platformOccupancy[stationId][assigned] = [];
  platformOccupancy[stationId][assigned].push({ start: windowStart, end: windowEnd });

  return assigned;
}

function getPlatformForStop(stop) {
  const train = timetableData.trains.find(t => t.trainId === stop.trainId);
  if (!train) return '—';

  // Check for active platform override first
  const key = `${stop.trainId}_${stop.stationId}`;
  if (window.platformOverrides && window.platformOverrides[key] && window.platformOverrides[key].active) {
    return window.platformOverrides[key].platform;
  }

  // Use arrival and departure times from the stop record so the platform
  // allocator can avoid time conflicts between trains sharing a platform.
  const arrSec = toSeconds(stop.arrival || stop.departure, stop.trainId);
  const depSec = toSeconds(stop.departure || stop.arrival, stop.trainId);

  return assignPlatform(
    stop.trainId,
    stop.stationId,
    train.serviceType,
    train.direction,
    arrSec,
    depSec
  );
}

/* ---------------- WAITING ROOM SYSTEM ---------------- */
function getWaitingRoom(platformNumber) {
  // Each group of 4 platforms shares a waiting room
  // Platforms 1-4 = Waiting Room 1, Platforms 5-8 = Waiting Room 2, etc.
  const waitingRoomNumber = Math.ceil(platformNumber / 4);
  return `${waitingRoomNumber}A / ${waitingRoomNumber}B`;
}

function getPlatformWaitingRoom(stationId, platformNumber) {
  const station = stationLookup[stationId];
  if (!station) return '—';
  
  const type = station.type;
  let waitingRoom;
  
  switch (type) {
    case 'LTD_EXPRESS':
      // 8 waiting rooms (1-8)
      waitingRoom = getWaitingRoom(platformNumber);
      break;
    case 'EXPRESS':
      // 6 waiting rooms (1-6)
      waitingRoom = getWaitingRoom(platformNumber);
      break;
    case 'LTD_LOCAL':
      // 4 waiting rooms (1-4)
      waitingRoom = getWaitingRoom(platformNumber);
      break;
    case 'LOCAL':
      // 2 waiting rooms (1-2)
      waitingRoom = getWaitingRoom(platformNumber);
      break;
    default:
      waitingRoom = getWaitingRoom(platformNumber);
  }
  
  return waitingRoom;
}

/* ---------------- TICKET CHECK SYSTEM ---------------- */
function getTicketCheckStatus(departureTime) {
  if (!departureTime || departureTime === '—') return null;
  
  const currentSeconds = getGMT12Seconds();
  const departureSeconds = toSeconds(departureTime);
  
  // Handle overnight departures
  let timeUntilDeparture = departureSeconds - currentSeconds;
  if (timeUntilDeparture < -43200) timeUntilDeparture += 86400;
  
  const status = {
    timeUntilDeparture: timeUntilDeparture,
    phase: '',
    message: ''
  };
  
  // Calculate ticket check start time (30 min before departure)
  let ticketCheckStart = departureSeconds - 1800;
  if (ticketCheckStart < 0) ticketCheckStart += 86400;
  
  if (timeUntilDeparture > 1800) {
    status.phase = 'waiting';
    status.message = 'Ticket check opens ' + formatTime(ticketCheckStart);
  } else if (timeUntilDeparture > 120) {
    status.phase = 'ticket_check';
    status.message = 'Ticket closes: ' + formatTime(departureSeconds - 60);
  } else if (timeUntilDeparture > 60) {
    status.phase = 'boarding';
    status.message = 'Ticket closes: ' + formatTime(departureSeconds - 60);
  } else if (timeUntilDeparture > 0) {
    status.phase = 'final_call';
    status.message = '⚠️ Closes at ' + formatTime(departureSeconds - 60) + '!';
  } else if (timeUntilDeparture > -60) {
    status.phase = 'departed';
    status.message = 'Departed';
  } else {
    status.phase = 'gone';
    status.message = 'Departed';
  }
  
  return status;
}

function formatTime(seconds) {
  // Convert seconds to HH:MM format for display
  let secs = seconds;
  if (secs < 0) secs += 86400;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ---------------- LIVE DEPARTURE BOARD ---------------- */
document.getElementById("startLiveBoard").onclick = () => {
  if (!timetableData) return;
  
  const stationId = document.getElementById("liveBoardStation").value;
  if (!stationId) return;
  
  const resultsDiv = document.getElementById("results");
  const panel = document.getElementById("timetablePanel");
  
  resultsDiv.innerHTML = "";
  panel.classList.add("hidden");
  
  // Clear any existing intervals
  if (liveBoardInterval) {
    clearInterval(liveBoardInterval);
    liveBoardInterval = null;
  }
  if (liveBoardRebuildInterval) {
    clearInterval(liveBoardRebuildInterval);
    liveBoardRebuildInterval = null;
  }
  
  // Initial render
  renderLiveDepartures(stationId);
  
  // Update countdown + status every second
  liveBoardInterval = setInterval(() => {
    updateLiveBoardStatuses(stationId);
  }, 1000);
  
  // Full rebuild every 30 seconds to catch new departures entering the 2h window
  liveBoardRebuildInterval = setInterval(() => {
    renderLiveDepartures(stationId);
  }, 30000);
};

document.getElementById("stopLiveBoard").onclick = () => {
  if (liveBoardInterval) {
    clearInterval(liveBoardInterval);
    liveBoardInterval = null;
  }
  if (liveBoardRebuildInterval) {
    clearInterval(liveBoardRebuildInterval);
    liveBoardRebuildInterval = null;
  }
  
  const resultsDiv = document.getElementById("results");
  resultsDiv.innerHTML = "<p>Live departures stopped.</p>";
};

function updateLiveBoardStatuses(stationId) {
  const rows = document.querySelectorAll('.live-departure-row');
  if (rows.length === 0) return;
  
  const currentSeconds = getGMT12Seconds();
  
  rows.forEach(row => {
    const departureTime = row.dataset.departureTime;
    const trainId = row.dataset.trainId;
    if (!departureTime || !trainId) return;
    
    const departureSeconds = toSeconds(departureTime, trainId);
    const countdownEl = row.querySelector('.countdown');
    const statusBadge = row.querySelector('.status-badge');
    
    if (!countdownEl || !statusBadge) return;
    
    let secondsUntilDeparture = departureSeconds - currentSeconds;
    if (secondsUntilDeparture < -43200) secondsUntilDeparture += 86400;
    
    const activeDelays = Object.values(window.trainDelays || {})
      .filter(d => d.trainId === trainId && d.active);
    const hasDelay = activeDelays.length > 0;
    const totalDelayMinutes = hasDelay 
      ? activeDelays.reduce((sum, d) => sum + d.minutes, 0) 
      : 0;
    
    const serviceStatus = window.serviceStatuses?.[trainId];
    const isCancelled = serviceStatus?.status === 'CANCELLED' && serviceStatus?.active;
    const isShortTerminated = serviceStatus?.status === 'SHORT_TERMINATED' && serviceStatus?.active;
    const isExpressRunning = serviceStatus?.status === 'EXPRESS_RUNNING' && serviceStatus?.active;
    
    // Update countdown
    if (secondsUntilDeparture <= -60) {
      countdownEl.textContent = 'Departed';
      countdownEl.style.color = '#95a5a6';
    } else if (secondsUntilDeparture <= 0) {
      countdownEl.textContent = 'Now';
      countdownEl.style.color = '#e74c3c';
    } else if (secondsUntilDeparture < 60) {
      countdownEl.textContent = `${secondsUntilDeparture}s`;
      countdownEl.style.color = '#e74c3c';
    } else if (secondsUntilDeparture < 300) {
      const minutes = Math.floor(secondsUntilDeparture / 60);
      const secs = secondsUntilDeparture % 60;
      countdownEl.textContent = `${minutes}m ${secs}s`;
      countdownEl.style.color = '#e67e22';
    } else if (secondsUntilDeparture < 3600) {
      countdownEl.textContent = `${Math.floor(secondsUntilDeparture / 60)}m`;
      countdownEl.style.color = '#27ae60';
    } else {
      const hours = Math.floor(secondsUntilDeparture / 3600);
      const minutes = Math.floor((secondsUntilDeparture % 3600) / 60);
      countdownEl.textContent = `${hours}h ${minutes}m`;
      countdownEl.style.color = '#3498db';
    }
    
    const departureSecondsTotal = toSeconds(departureTime, trainId);
    let ticketCheckStart = departureSecondsTotal - 1800;
    if (ticketCheckStart < 0) ticketCheckStart += 86400;
    
    let trainStatus = '';
    let ticketInfo = '';
    let statusClass = '';
    
    if (isCancelled) {
      trainStatus = 'CANCELLED';
      ticketInfo = 'Service cancelled';
      statusClass = 'status-cancelled';
    } else if (secondsUntilDeparture <= -60) {
      trainStatus = 'DEPARTED';
      ticketInfo = 'Train has departed';
      statusClass = 'status-departed';
    } else if (secondsUntilDeparture <= 0) {
      trainStatus = 'DEPARTING';
      ticketInfo = 'Ticket closed';
      statusClass = 'status-departing';
    } else if (secondsUntilDeparture <= 60) {
      trainStatus = 'FINAL CALL';
      ticketInfo = `⚠️ Closes at ${formatTime(departureSecondsTotal - 60)}!`;
      statusClass = 'status-final-call';
    } else if (secondsUntilDeparture <= 120) {
      trainStatus = 'BOARDING';
      ticketInfo = `Ticket closes: ${formatTime(departureSecondsTotal - 60)}`;
      statusClass = 'status-boarding';
    } else if (hasDelay) {
      trainStatus = 'DELAYED';
      ticketInfo = `Delayed ${totalDelayMinutes}min • Ticket check: ${formatTime(ticketCheckStart)}`;
      statusClass = 'status-delayed';
    } else if (secondsUntilDeparture > 1800) {
      trainStatus = 'SCHEDULED';
      ticketInfo = `Ticket check: ${formatTime(ticketCheckStart)}`;
      statusClass = 'status-scheduled';
    } else {
      trainStatus = 'ON TIME';
      ticketInfo = `Ticket closes: ${formatTime(departureSecondsTotal - 60)}`;
      statusClass = 'status-ontime';
    }
    
    if (!isCancelled) {
      if (isShortTerminated) {
        trainStatus = 'SHORT TERMINATED';
        ticketInfo = serviceStatus?.terminationStation 
          ? `Terminates at ${stationLookup[serviceStatus.terminationStation]?.name || serviceStatus.terminationStation}`
          : 'Short terminated';
        statusClass = 'status-short-terminated';
      } else if (isExpressRunning) {
        trainStatus = 'EXPRESS RUNNING';
        ticketInfo = 'Skipping some stations';
        statusClass = 'status-express-running';
      }
    }
    
    statusBadge.innerHTML = `${trainStatus}<br><small class="ticket-info">${escapeHtml(ticketInfo)}</small>`;
    statusBadge.className = `status-badge ${statusClass}`;
  });
}

function renderLiveDepartures(stationId) {
  const resultsDiv = document.getElementById("results");
  const station = stationLookup[stationId];
  const currentSeconds = getGMT12Seconds();
  
  // Get all stops from this station
  const allStops = stopsByStation[stationId] || [];
  
  // Filter: ONLY show trains that actually DEPART from this station (not terminating trains)
  const upcomingDepartures = allStops
    .filter(stop => {
      // Skip if this train terminates at this station (no departure)
      if (isTerminatingStop(stop, stop.trainId)) {
        return false;
      }
      
      // Skip if there's no departure time (arrival-only stop)
      if (!stop.departure || stop.departure === '—') {
        return false;
      }
      
      const depTime = toSeconds(stop.departure, stop.trainId);  // PASS trainId
      let timeDiff = depTime - currentSeconds;
      if (timeDiff < -43200) timeDiff += 86400;
      return timeDiff >= -60 && timeDiff <= 7200;
    })
    .map(stop => {
      const train = timetableData.trains.find(t => t.trainId === stop.trainId);
      const trainStops = stopsByTrain[stop.trainId];
      const origin = trainStops[0];
      const terminus = trainStops[trainStops.length - 1];
      
      let timeDiff = toSeconds(stop.departure, stop.trainId) - currentSeconds;  // PASS trainId
      if (timeDiff < -43200) timeDiff += 86400;
      const platform = getPlatformForStop(stop);
      
      // Check for active delays
      const activeDelays = Object.values(window.trainDelays || {})
        .filter(d => d.trainId === stop.trainId && d.active);
      const hasDelay = activeDelays.length > 0;
      const totalDelayMinutes = hasDelay 
        ? activeDelays.reduce((sum, d) => sum + d.minutes, 0) 
        : 0;
      
      // Check for service status
      const serviceStatus = window.serviceStatuses?.[stop.trainId];
      const isCancelled = serviceStatus?.status === 'CANCELLED' && serviceStatus?.active;
      
      return {
        trainId: stop.trainId,
        serviceType: train ? train.serviceType.replaceAll("_", " ") : "—",
        direction: train ? train.direction : "—",
        origin: stationLookup[origin.stationId]?.name || origin.stationId,
        destination: stationLookup[terminus.stationId]?.name || terminus.stationId,
        departure: stop.departure || "—",
        arrival: stop.arrival || "—",
        platform: platform,
        timeDiff: timeDiff,
        hasDelay: hasDelay,
        totalDelayMinutes: totalDelayMinutes,
        isCancelled: isCancelled,
        serviceStatus: serviceStatus
      };
    })
    .sort((a, b) => a.timeDiff - b.timeDiff);
  
  const nowString = getGMT12Time().toISOString().replace('T', ' ').substring(0, 19);
  const syncStatus = atomicTimeSynced ? '⚛ Atomic Time' : '⏳ Local Time';
  
  let html = `
    <div class="live-board-container">
      <div class="live-board-header">
        <div class="live-board-title">
          <h2>${stationAliases[stationId] || station.name} - Live Departures</h2>
          <div class="live-clock-large">${nowString} GMT+12</div>
        </div>
        <div class="live-board-status">
          <span class="live-dot"></span> ${syncStatus} • ${upcomingDepartures.length} departures in next 2 hours
        </div>
      </div>
    <table class="results-table live-board-table">
      <thead>
        <tr>
          <th>Scheduled</th>
          <th>Countdown</th>
          <th>Train</th>
          <th>Type</th>
          <th>To</th>
          <th>Platform</th>
          <th>Waiting Room</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
  `;
  
  if (upcomingDepartures.length === 0) {
    html += `
      <tr>
        <td colspan="8" style="text-align: center; padding: 20px; color: #95a5a6;">
          No departures in the next 2 hours
        </td>
      </tr>
    `;
  } else {
    upcomingDepartures.forEach(dep => {
      const waitingRoom = getPlatformWaitingRoom(stationId, dep.platform);
      const countdownText = dep.timeDiff > 0 ? formatLayover(dep.timeDiff) : 'Departed';
      const dirClass = dep.direction === "CW" ? "dir-cw" : "dir-ccw";
      
      // Calculate status with delays already factored in
      const departureSeconds = toSeconds(dep.departure, dep.trainId);  // PASS trainId
      let ticketCheckStart = departureSeconds - 1800;
      if (ticketCheckStart < 0) ticketCheckStart += 86400;
      
      let trainStatus = '';
      let ticketInfo = '';
      let statusClass = '';
      
      if (dep.isCancelled) {
        trainStatus = 'CANCELLED';
        ticketInfo = 'Service cancelled';
        statusClass = 'status-cancelled';
      } else if (dep.timeDiff <= -60) {
        trainStatus = 'DEPARTED';
        ticketInfo = 'Train has departed';
        statusClass = 'status-departed';
      } else if (dep.timeDiff <= 0) {
        trainStatus = 'DEPARTING';
        ticketInfo = 'Ticket closed';
        statusClass = 'status-departing';
      } else if (dep.timeDiff <= 60) {
        trainStatus = 'FINAL CALL';
        ticketInfo = `⚠️ Closes at ${formatTime(departureSeconds - 60)}!`;
        statusClass = 'status-final-call';
      } else if (dep.timeDiff <= 120) {
        trainStatus = 'BOARDING';
        ticketInfo = `Ticket closes: ${formatTime(departureSeconds - 60)}`;
        statusClass = 'status-boarding';
      } else if (dep.hasDelay) {
        trainStatus = 'DELAYED';
        ticketInfo = `Delayed ${dep.totalDelayMinutes}min • Check: ${formatTime(ticketCheckStart)}`;
        statusClass = 'status-delayed';
      } else if (dep.timeDiff > 1800) {
        trainStatus = 'SCHEDULED';
        ticketInfo = `Ticket check: ${formatTime(ticketCheckStart)}`;
        statusClass = 'status-scheduled';
      } else {
        trainStatus = 'ON TIME';
        ticketInfo = `Ticket closes: ${formatTime(departureSeconds - 60)}`;
        statusClass = 'status-ontime';
      }
      
      // Service status overrides
      if (!dep.isCancelled) {
        if (dep.serviceStatus?.status === 'SHORT_TERMINATED' && dep.serviceStatus?.active) {
          trainStatus = 'SHORT TERMINATED';
          ticketInfo = dep.serviceStatus?.terminationStation 
            ? `Terminates at ${stationLookup[dep.serviceStatus.terminationStation]?.name || dep.serviceStatus.terminationStation}`
            : 'Short terminated';
          statusClass = 'status-short-terminated';
        } else if (dep.serviceStatus?.status === 'EXPRESS_RUNNING' && dep.serviceStatus?.active) {
          trainStatus = 'EXPRESS RUNNING';
          ticketInfo = 'Skipping some stations';
          statusClass = 'status-express-running';
        }
      }
      
      html += `
        <tr class="live-departure-row" data-departure-time="${dep.departure}" data-train-id="${dep.trainId}">
          <td class="time-cell">${dep.departure}</td>
          <td class="countdown-cell">
            <span class="countdown">${countdownText}</span>
          </td>
          <td><span class="train-badge">${dep.trainId}</span></td>
          <td class="type-cell">${dep.serviceType}</td>
          <td>
            ${dep.destination}
            <br><small><span class="dir-badge ${dirClass}">${dep.direction}</span></small>
          </td>
          <td><strong>P${dep.platform}</strong></td>
          <td>${waitingRoom}</td>
          <td><span class="status-badge ${statusClass}" style="white-space: normal; line-height: 1.3;">${trainStatus}<br><small class="ticket-info">${ticketInfo}</small></span></td>
        </tr>
      `;
    });
  }
  
  html += `
        </tbody>
      </table>
      <div class="live-board-footer">
        <small>Updates every second • ${syncStatus} • Last updated: ${nowString}</small>
      </div>
    </div>
  `;
  
  resultsDiv.innerHTML = html;
}

/* ---------------- STATION SEARCH ---------------- */
function normalizeServiceType(str) {
  return str.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

document.getElementById("searchBtn").onclick = () => {
  if (!timetableData) return;

  const fromId = document.getElementById("fromStation").value;
  const toId   = document.getElementById("toStation").value;
  const timeRaw = document.getElementById("departureTime").value;
  const after = timeRaw ? (timeRaw.length === 5 ? timeRaw + ":00" : timeRaw) : "00:00:00";
  const beforeRaw = document.getElementById("departureBefore").value;
  const before = beforeRaw ? (beforeRaw.length === 5 ? beforeRaw + ":00" : beforeRaw) : "23:59:59";
  const typeFilter = document.getElementById("trainTypeFilter").value;
  const maxStopovers = parseInt(document.getElementById("maxStopovers").value);
  const maxLayoverMin = parseInt(document.getElementById("maxLayover").value);
  const maxLayoverSec = maxLayoverMin * 60;
  const resultsDiv = document.getElementById("results");
  const loading = document.getElementById("loading");
  const panel = document.getElementById("timetablePanel");

  resultsDiv.innerHTML = "";
  panel.classList.add("hidden");
  loading.classList.remove("hidden");

  setTimeout(() => {
    const fromSt = stationLookup[fromId];
    const toSt = stationLookup[toId];

    if (!fromSt || !toSt || samePhysicalStation(fromId, toId)) {
      loading.classList.add("hidden");
      resultsDiv.innerHTML = "<p>Invalid station selection.</p>";
      return;
    }

    console.log(`Searching ${fromSt.name} → ${toSt.name}`);
    console.log(`Max stopovers: ${maxStopovers}, Max layover: ${maxLayoverMin}min`);
    
    // Find all possible journeys
    const allJourneys = [];
    
    // Find direct journeys first
    findDirectJourneys(fromId, toId, after, before, typeFilter, allJourneys);
    console.log(`Direct journeys: ${allJourneys.length}`);
    
    // Find journeys with transfers
    if (maxStopovers > 0) {
      findTransferJourneys(fromId, toId, after, before, typeFilter, maxStopovers, maxLayoverSec, allJourneys);
    }
    
    console.log(`Total journeys found: ${allJourneys.length}`);
    
    // Filter and sort for best results
    const smartResults = filterAndSortJourneys(allJourneys);
    
    console.log(`After filtering: ${smartResults.length} journeys`);
    
    loading.classList.add("hidden");

    if (!smartResults.length) {
      resultsDiv.innerHTML = `<p>No suitable journeys found between ${fromSt.name} and ${toSt.name}. Try adjusting your filters or increasing max stopovers.</p>`;
      return;
    }

    renderResultsTable(smartResults, fromSt, toSt);

    if (currentUser) {
      addRecentSearch(fromId, toId);
    }

  }, 200);
};

/* ---------------- DIRECT JOURNEY FINDER ---------------- */
function findDirectJourneys(fromId, toId, after, before, typeFilter, results) {
  const afterSec = toSeconds(after);
  const beforeSec = toSeconds(before);
  
  const departures = stopsByStation[fromId] || [];
  
  for (const departure of departures) {
    const depTime = toSeconds(departure.departure || departure.arrival);
    if (depTime < afterSec || depTime > beforeSec) continue;
    
    const train = timetableData.trains.find(t => t.trainId === departure.trainId);
    if (!train) continue;
    
    if (typeFilter && normalizeServiceType(train.serviceType) !== normalizeServiceType(typeFilter)) continue;
    
    const trainStops = stopsByTrain[departure.trainId];
    const toIds = allAliasIds(toId);
    const destStop = trainStops.find(s => 
      toIds.includes(s.stationId) && 
      s.sequence > departure.sequence
    );
    
    if (destStop) {
      const dur = journeyDurationSeconds(departure.departure, destStop.arrival, null, departure, destStop, trainStops);
      // Must be at least 2 minutes (no upper cap — ring-line journeys can exceed 24h)
      if (dur >= 120) {
        results.push({
          legs: [{
            train: train,
            from: departure,
            to: destStop
          }],
          departureTime: departure.departure,
          arrivalTime: destStop.arrival,
          durationSec: dur,
          stopovers: 0
        });
      }
    }
  }
}

/* ---------------- TRANSFER JOURNEY FINDER ---------------- */
function findTransferJourneys(fromId, toId, after, before, typeFilter, maxStopovers, maxLayoverSec, results) {
  const afterSec = toSeconds(after);
  const beforeSec = toSeconds(before);
  
  // Get all possible first legs
  const firstLegs = stopsByStation[fromId] || [];
  
  for (const firstDeparture of firstLegs) {
    const depTime = toSeconds(firstDeparture.departure || firstDeparture.arrival);
    if (depTime < afterSec || depTime > beforeSec) continue;
    
    const firstTrain = timetableData.trains.find(t => t.trainId === firstDeparture.trainId);
    if (!firstTrain) continue;
    
    if (typeFilter && normalizeServiceType(firstTrain.serviceType) !== normalizeServiceType(typeFilter)) continue;
    
    const firstTrainStops = stopsByTrain[firstDeparture.trainId];
    
    // Collect the set of stations the first train visits before the transfer
    // (used to detect backtracking on the second leg)
    const firstLegStationSet = new Set(
      firstTrainStops
        .filter(s => s.sequence <= firstDeparture.sequence)
        .map(s => s.stationId)
    );
    // Also note which stations the first leg passes through AFTER boarding
    const firstLegPassthrough = new Set(
      firstTrainStops
        .filter(s => s.sequence > firstDeparture.sequence)
        .map(s => s.stationId)
    );

    // Get all possible transfer stations from this first train
    // Exclude origin and destination (destination would be a direct journey)
    const toIds = allAliasIds(toId);
    const fromIds = allAliasIds(fromId);
    const possibleTransfers = firstTrainStops.filter(s => 
      s.sequence > firstDeparture.sequence && 
      !fromIds.includes(s.stationId) &&
      !toIds.includes(s.stationId)
    );

    // Don't consider any transfer station that the first train only reaches AFTER
    // it has already passed through the destination (going the long way round)
    const destOnFirstTrain = firstTrainStops.find(
      s => toIds.includes(s.stationId) && s.sequence > firstDeparture.sequence
    );
    const filteredTransfers = destOnFirstTrain
      ? possibleTransfers.filter(s => s.sequence < destOnFirstTrain.sequence)
      : possibleTransfers;
    
    for (const transferStop of filteredTransfers) {
      const arrivalAtTransfer = toSeconds(transferStop.arrival);
      
      // Find all possible second legs from transfer station
      const secondLegs = stopsByStation[transferStop.stationId] || [];
      
      for (const secondDeparture of secondLegs) {
        let secondDepTime = toSeconds(secondDeparture.departure || secondDeparture.arrival);
        // Handle midnight crossover at the transfer station
        let layover = secondDepTime - arrivalAtTransfer;
        if (layover < 0) layover += 86400; // second train departs next day
        
        // Check layover constraints
        if (layover < MIN_LAYOVER_SECONDS || layover > maxLayoverSec) continue;
        
        const secondTrain = timetableData.trains.find(t => t.trainId === secondDeparture.trainId);
        if (!secondTrain || secondTrain.trainId === firstTrain.trainId) continue;
        
        if (typeFilter && normalizeServiceType(secondTrain.serviceType) !== normalizeServiceType(typeFilter)) continue;
        
        const secondTrainStops = stopsByTrain[secondDeparture.trainId];

        // Find destination on the second train, after the transfer point
        const destStop = secondTrainStops.find(s => 
          toIds.includes(s.stationId) && 
          s.sequence > secondDeparture.sequence
        );

        if (!destStop) continue;

        // Reject if the second leg passes through the origin station before reaching
        // the destination (that means the journey goes "the long way round")
        const secondLegToDestination = secondTrainStops.filter(
          s => s.sequence > secondDeparture.sequence && s.sequence <= destStop.sequence
        );
        const passesBackThroughOrigin = secondLegToDestination.some(s => fromIds.includes(s.stationId));
        if (passesBackThroughOrigin) continue;

        // Also reject if the second leg passes through the transfer station itself again
        // before reaching the destination (degenerate loop)
        const secondLegVisitsTransferAgain = secondLegToDestination.some(
          s => s.stationId === transferStop.stationId && s.sequence !== secondDeparture.sequence
        );
        if (secondLegVisitsTransferAgain) continue;
        
        // Found a valid journey with 1 transfer!
        // Duration = leg1 + layover + leg2, computed segment-by-segment per leg
        const leg1dur = journeyDurationSeconds(firstDeparture.departure, transferStop.arrival, null, firstDeparture, transferStop, firstTrainStops);
        const leg2dur = journeyDurationSeconds(secondDeparture.departure, destStop.arrival, null, secondDeparture, destStop, secondTrainStops);
        const dur = leg1dur + layover + leg2dur;
        // Sanity: must be at least 4 minutes
        if (dur < 240) continue;
        const journey = {
          legs: [
            {
              train: firstTrain,
              from: firstDeparture,
              to: transferStop
            },
            {
              train: secondTrain,
              from: secondDeparture,
              to: destStop
            }
          ],
          departureTime: firstDeparture.departure,
          arrivalTime: destStop.arrival,
          durationSec: dur,
          stopovers: 1,
          layoverSec: layover
        };
        
        results.push(journey);
        
        // If more stopovers allowed, look for 2-transfer journeys
        if (maxStopovers >= 2) {
          findThirdLegJourneys(journey, toId, typeFilter, maxStopovers, maxLayoverSec, results);
        }
      }
    }
  }
}

function findThirdLegJourneys(firstTwoLegs, toId, typeFilter, maxStopovers, maxLayoverSec, results) {
  // We already have a complete journey, but let's see if we can find alternatives
  // by extending from the middle transfer point
  const middleStation = firstTwoLegs.legs[0].to.stationId;
  const middleArrival = toSeconds(firstTwoLegs.legs[0].to.arrival);
  
  const alternativeSecondLegs = stopsByStation[middleStation] || [];
  
  for (const altSecondDep of alternativeSecondLegs) {
    const altDepTime = toSeconds(altSecondDep.departure || altSecondDep.arrival);
    let layover = altDepTime - middleArrival;
    if (layover < 0) layover += 86400; // midnight crossover
    
    if (layover < MIN_LAYOVER_SECONDS || layover > maxLayoverSec) continue;
    
    const altSecondTrain = timetableData.trains.find(t => t.trainId === altSecondDep.trainId);
    if (!altSecondTrain || altSecondTrain.trainId === firstTwoLegs.legs[0].train.trainId) continue;
    
    if (typeFilter && normalizeServiceType(altSecondTrain.serviceType) !== normalizeServiceType(typeFilter)) continue;
    
    const altSecondStops = stopsByTrain[altSecondDep.trainId];
    
    // First check if this alternative second leg goes directly to destination
    const toIdsAlt = allAliasIds(toId);
    const directDest = altSecondStops.find(s => 
      toIdsAlt.includes(s.stationId) && 
      s.sequence > altSecondDep.sequence
    );
    
    if (!directDest) {
      // Look for transfer stations for a third leg
      const toIdsThird = allAliasIds(toId);
      const possibleThirdTransfers = altSecondStops.filter(s => 
        s.sequence > altSecondDep.sequence && 
        s.stationId !== middleStation &&
        !toIdsThird.includes(s.stationId)
      );
      
      for (const thirdTransfer of possibleThirdTransfers) {
        const arrivalAtThird = toSeconds(thirdTransfer.arrival);
        
        const thirdLegs = stopsByStation[thirdTransfer.stationId] || [];
        
        for (const thirdDep of thirdLegs) {
          const thirdDepTime = toSeconds(thirdDep.departure || thirdDep.arrival);
          let thirdLayover = thirdDepTime - arrivalAtThird;
          if (thirdLayover < 0) thirdLayover += 86400; // midnight crossover
          
          if (thirdLayover < MIN_LAYOVER_SECONDS || thirdLayover > maxLayoverSec) continue;
          
          const thirdTrain = timetableData.trains.find(t => t.trainId === thirdDep.trainId);
          if (!thirdTrain || 
              thirdTrain.trainId === firstTwoLegs.legs[0].train.trainId || 
              thirdTrain.trainId === altSecondTrain.trainId) continue;
          
          if (typeFilter && normalizeServiceType(thirdTrain.serviceType) !== normalizeServiceType(typeFilter)) continue;
          
          const thirdStops = stopsByTrain[thirdDep.trainId];
          const finalDest = thirdStops.find(s => 
            toIdsThird.includes(s.stationId) && 
            s.sequence > thirdDep.sequence
          );
          
          if (finalDest) {
            // Duration = sum of all leg durations + layovers
            const leg1d = journeyDurationSeconds(firstTwoLegs.legs[0].from.departure, firstTwoLegs.legs[0].to.arrival, null, firstTwoLegs.legs[0].from, firstTwoLegs.legs[0].to, stopsByTrain[firstTwoLegs.legs[0].train.trainId]);
            const leg2d = journeyDurationSeconds(altSecondDep.departure, thirdTransfer.arrival, null, altSecondDep, thirdTransfer, altSecondStops);
            const leg3d = journeyDurationSeconds(thirdDep.departure, finalDest.arrival, null, thirdDep, finalDest, thirdStops);
            const dur = leg1d + layover + leg2d + thirdLayover + leg3d;
            if (dur < 240) continue;
            const journey = {
              legs: [
                firstTwoLegs.legs[0],
                {
                  train: altSecondTrain,
                  from: altSecondDep,
                  to: thirdTransfer
                },
                {
                  train: thirdTrain,
                  from: thirdDep,
                  to: finalDest
                }
              ],
              departureTime: firstTwoLegs.departureTime,
              arrivalTime: finalDest.arrival,
              durationSec: dur,
              stopovers: 2,
              layoverSec: [layover, thirdLayover]
            };
            results.push(journey);
          }
        }
      }
    }
  }
}

/* ---------------- SMART FILTERING & SORTING ---------------- */
function filterAndSortJourneys(results) {
  if (results.length === 0) return [];
  
  console.log(`Processing ${results.length} journeys...`);
  const startTime = performance.now();
  
  // Remove duplicate journeys (optimized with Map for large arrays)
  const unique = new Map();
  
  for (const journey of results) {
    const key = journey.legs.map(l => l.train.trainId + ':' + l.from.stationId + ':' + l.to.stationId).join('|');
    if (!unique.has(key)) {
      unique.set(key, journey);
    }
  }
  
  const uniqueArray = Array.from(unique.values());
  console.log(`Unique journeys: ${uniqueArray.length} (removed ${results.length - uniqueArray.length} duplicates)`);
  
  // Find fastest direct journey
  const directJourneys = uniqueArray.filter(j => j.stopovers === 0);
  const fastestDirect = directJourneys.length ? Math.min(...directJourneys.map(j => j.durationSec)) : Infinity;
  const fastestOverall = Math.min(...uniqueArray.map(j => j.durationSec));
  
  // Filter in batches to avoid call stack issues
  const realistic = [];
  const batchSize = 10000;
  
  for (let i = 0; i < uniqueArray.length; i += batchSize) {
    const batch = uniqueArray.slice(i, Math.min(i + batchSize, uniqueArray.length));
    
    for (const journey of batch) {
      // Journey must be at least 2 minutes
      if (journey.durationSec < 120) continue;
      
      // Never discard direct journeys
      if (journey.stopovers === 0) {
        realistic.push(journey);
        continue;
      }
      
      // For transfer journeys: only keep reasonable ones
      const baseline = fastestDirect !== Infinity ? fastestDirect : fastestOverall;
      if (journey.durationSec <= baseline * 4 || journey.durationSec <= 7200) {
        realistic.push(journey);
      }
    }
    
    // Allow UI to breathe
    if (i % 50000 === 0 && i > 0) {
      console.log(`Processed ${i}/${uniqueArray.length} journeys...`);
    }
  }
  
  console.log(`Realistic journeys: ${realistic.length}`);
  
  // Sort by duration (works on smaller array)
  realistic.sort((a, b) => {
    if (a.durationSec !== b.durationSec) return a.durationSec - b.durationSec;
    return a.stopovers - b.stopovers;
  });
  
  const endTime = performance.now();
  console.log(`Filtering completed in ${(endTime - startTime).toFixed(0)}ms`);
  
  // Return top 100 results
  return realistic.slice(0, 100);
}

/* ================================================================
   FARE CALCULATION SYSTEM
   ================================================================ */

// Fare constants – REVISED for realistic pricing
const FARE_CONSTANTS = {
  BASE_RATE: 0.03,           // DSD per km for Third class LOCAL train (350 km/h)
  MINIMUM_FARE: 2,            // Minimum fare in DSD
  HALF_LOOP_CAP: 2191,        // Half loop distance cap (km)
  TOTAL_LOOP: 4383.41,        // Full loop distance (km)
  
  CLASS_MULTIPLIERS: {
    'Third': 1.00,
    'Second': 1.50,
    'First': 3.00
  },
  
  TRAIN_MULTIPLIERS: {
    'LOCAL': 1.00,
    'LTD_LOCAL': 1.14,
    'EXPRESS': 1.29,
    'LTD_EXPRESS': 1.43
  },
  
  STATION_SURCHARGES: {
    'LTD_EXPRESS': 2.5,
    'EXPRESS': 1.5,
    'LTD_LOCAL': 1,
    'LOCAL': 0
  }
};

/* ================================================================
   TRAIN CONSIST & SEATING ENGINE
   ================================================================ */

// Car type definitions (cab is handled separately)
const CAR_CONFIGS = {
  CAB:     { code: 'CAB',  rows: 15, firstRows:15, secondRows:0, thirdRows:0, classMap: { first: true } },
  CONFIG1: { code: 'C1',   rows: 21, firstRows:21, secondRows:0, thirdRows:0, classMap: { first: true } },
  CONFIG2: { code: 'C2',   rows: 22, firstRows:10, secondRows:12, thirdRows:0, classMap: { first: true, second: true } },
  CONFIG3: { code: 'C3',   rows: 25, firstRows:0, secondRows:25, thirdRows:0, classMap: { second: true } },
  CONFIG4: { code: 'C4',   rows: 27, firstRows:0, secondRows:12, thirdRows:15, classMap: { second: true, third: true } },
  CONFIG5: { code: 'C5',   rows: 31, firstRows:0, secondRows:0, thirdRows:31, classMap: { third: true } }
};

// Train class → (minCars, maxCars, preferred length)
const TRAIN_CLASS_PARAMS = {
  LOCAL:      { min:2, max:8,  typical:6 },
  LTD_LOCAL:  { min:4, max:10, typical:8 },
  EXPRESS:    { min:6, max:14, typical:10 },
  LTD_EXPRESS:{ min:8, max:16, typical:12 }
};

// Deterministic pseudo‑random based on train ID (to keep consist stable)
function seededRandom(seed, index) {
  let x = Math.sin(seed + index) * 10000;
  return x - Math.floor(x);
}

// Generate car sequence for a given train
function generateTrainConsist(trainId, serviceType) {
  const params = TRAIN_CLASS_PARAMS[serviceType] || TRAIN_CLASS_PARAMS.LOCAL;
  let numCars = params.typical;
  // slight variation based on trainId hash (peak/off‑peak simulation)
  let hash = 0;
  for (let i = 0; i < trainId.length; i++) hash = ((hash << 5) - hash) + trainId.charCodeAt(i);
  hash = Math.abs(hash);
  numCars += (hash % 3) - 1;               // -1,0,+1
  numCars = Math.min(params.max, Math.max(params.min, numCars));
  
  // Exactly two cab cars (ends)
  const cars = [];
  cars.push({ type: 'CAB', index: 0, ...CAR_CONFIGS.CAB });
  
  // Fill intermediate cars using a weighted distribution suitable for the class
  const availableTypes = [];
  if (serviceType === 'LTD_EXPRESS') availableTypes.push('CONFIG1', 'CONFIG2', 'CONFIG3');
  else if (serviceType === 'EXPRESS') availableTypes.push('CONFIG2', 'CONFIG3', 'CONFIG4');
  else if (serviceType === 'LTD_LOCAL') availableTypes.push('CONFIG3', 'CONFIG4', 'CONFIG5');
  else availableTypes.push('CONFIG3', 'CONFIG4', 'CONFIG5');
  
  for (let i = 1; i < numCars - 1; i++) {
    let choice;
    if (serviceType === 'LTD_EXPRESS') {
      const r = seededRandom(hash + i, i);
      if (r < 0.3) choice = 'CONFIG1';
      else if (r < 0.7) choice = 'CONFIG2';
      else choice = 'CONFIG3';
    } else if (serviceType === 'EXPRESS') {
      const r = seededRandom(hash + i, i);
      if (r < 0.4) choice = 'CONFIG2';
      else if (r < 0.8) choice = 'CONFIG3';
      else choice = 'CONFIG4';
    } else {
      const r = seededRandom(hash + i, i);
      if (r < 0.3) choice = 'CONFIG3';
      else if (r < 0.7) choice = 'CONFIG4';
      else choice = 'CONFIG5';
    }
    cars.push({ type: choice, index: i, ...CAR_CONFIGS[choice] });
  }
  cars.push({ type: 'CAB', index: numCars-1, ...CAR_CONFIGS.CAB });
  
  return { cars, numCars };
}

// Build seat map for a given car
function buildSeatMap(car) {
  const seats = [];
  const { rows, firstRows, secondRows, thirdRows, classMap } = car;
  for (let row = 1; row <= rows; row++) {
    const rowLetter = String.fromCharCode(64 + row); // A=1, B=2, ...
    if (classMap.first) {
      seats.push({ seat: `${rowLetter}A`, class: 'first', occupied: false, row, col: 'A' });
      seats.push({ seat: `${rowLetter}F`, class: 'first', occupied: false, row, col: 'F' });
    }
    if (classMap.second) {
      seats.push({ seat: `${rowLetter}A`, class: 'second', occupied: false, row, col: 'A' });
      seats.push({ seat: `${rowLetter}C`, class: 'second', occupied: false, row, col: 'C' });
      seats.push({ seat: `${rowLetter}D`, class: 'second', occupied: false, row, col: 'D' });
      seats.push({ seat: `${rowLetter}F`, class: 'second', occupied: false, row, col: 'F' });
    }
    if (classMap.third) {
      seats.push({ seat: `${rowLetter}A`, class: 'third', occupied: false, row, col: 'A' });
      seats.push({ seat: `${rowLetter}B`, class: 'third', occupied: false, row, col: 'B' });
      seats.push({ seat: `${rowLetter}C`, class: 'third', occupied: false, row, col: 'C' });
      seats.push({ seat: `${rowLetter}D`, class: 'third', occupied: false, row, col: 'D' });
      seats.push({ seat: `${rowLetter}E`, class: 'third', occupied: false, row, col: 'E' });
      seats.push({ seat: `${rowLetter}F`, class: 'third', occupied: false, row, col: 'F' });
    }
    // Deduplicate in mixed cars (first/second share A,F)
    if (classMap.first && classMap.second) {
      // Remove duplicate A/F from second class
      const toRemove = new Set();
      seats.forEach((s, idx) => {
        if (s.class === 'second' && (s.col === 'A' || s.col === 'F')) toRemove.add(idx);
      });
      for (let idx of [...toRemove].sort((a,b)=>b-a)) seats.splice(idx,1);
    }
    if (classMap.second && classMap.third) {
      // keep both but third adds B/E, second adds C/D – no overlap
    }
  }
  return seats;
}

// Get all available seats for a train and class
function getAvailableSeats(trainId, serviceType, travelClass) {
  const consist = generateTrainConsist(trainId, serviceType);
  const available = [];
  consist.cars.forEach((car, carIdx) => {
    const seats = buildSeatMap(car);
    seats.forEach(seat => {
      if (seat.class === travelClass) {
        available.push({
          car: carIdx + 1,
          carType: car.type,
          seat: seat.seat,
          row: seat.row,
          class: seat.class
        });
      }
    });
  });
  return available;
}

// Station data with distances and types
const STATION_DATA = [
  { name: "Set", type: "LTD_EXPRESS", totalDistance: 0 },
  { name: "Set South", type: "LTD_LOCAL", totalDistance: 74.9 },
  { name: "Franklin Airport", type: "EXPRESS", totalDistance: 111.17 },
  { name: "Galaxy", type: "LTD_LOCAL", totalDistance: 150.59 },
  { name: "Galaxy South", type: "LOCAL", totalDistance: 234.95 },
  { name: "Réstön", type: "LTD_LOCAL", totalDistance: 282.25 },
  { name: "Réstön South", type: "LOCAL", totalDistance: 310.63 },
  { name: "Bay of Set", type: "LOCAL", totalDistance: 358.72 },
  { name: "Taśtök North", type: "LOCAL", totalDistance: 387.89 },
  { name: "Taśtök", type: "EXPRESS", totalDistance: 407.6 },
  { name: "Taśtök South", type: "LOCAL", totalDistance: 436.77 },
  { name: "Jeso North", type: "LOCAL", totalDistance: 469.88 },
  { name: "Jeso", type: "LTD_EXPRESS", totalDistance: 533.74 },
  { name: "Jeso South", type: "LOCAL", totalDistance: 557.39 },
  { name: "Astóńksér", type: "LTD_LOCAL", totalDistance: 586.56 },
  { name: "Astóńksér-Siëra", type: "LOCAL", totalDistance: 618.1 },
  { name: "Siëra", type: "LTD_LOCAL", totalDistance: 655.15 },
  { name: "Siëña", type: "EXPRESS", totalDistance: 706.39 },
  { name: "Ukarënósétpö", type: "LOCAL", totalDistance: 737.14 },
  { name: "Ukarënósétpö-Sytöul", type: "EXPRESS", totalDistance: 759.21 },
  { name: "Sytöul", type: "LOCAL", totalDistance: 784.44 },
  { name: "Dëstra-nof", type: "LOCAL", totalDistance: 808.09 },
  { name: "Dëstra", type: "LTD_LOCAL", totalDistance: 829.38 },
  { name: "Dëstra-sof", type: "LOCAL", totalDistance: 852.24 },
  { name: "Viéräst", type: "EXPRESS", totalDistance: 871.95 },
  { name: "Peioms", type: "LTD_LOCAL", totalDistance: 915.31 },
  { name: "Lobset-nof", type: "LOCAL", totalDistance: 961.82 },
  { name: "Lobset", type: "LTD_EXPRESS", totalDistance: 1032.77 },
  { name: "Lobset-sof", type: "LOCAL", totalDistance: 1078.5 },
  { name: "Noisi-parl", type: "EXPRESS", totalDistance: 1119.5 },
  { name: "Noisi-de-touché", type: "LTD_LOCAL", totalDistance: 1145.52 },
  { name: "Chagny-on-bochy", type: "EXPRESS", totalDistance: 1168.38 },
  { name: "Sin-nof", type: "LOCAL", totalDistance: 1207.8 },
  { name: "Sin", type: "LTD_EXPRESS", totalDistance: 1265.35 },
  { name: "Sin-sof", type: "LOCAL", totalDistance: 1308.71 },
  { name: "Læmëré", type: "EXPRESS", totalDistance: 1350.49 },
  { name: "Læmëré-sof", type: "LOCAL", totalDistance: 1374.14 },
  { name: "Châleté", type: "LTD_LOCAL", totalDistance: 1430.9 },
  { name: "Cïtêrè", type: "EXPRESS", totalDistance: 1466.38 },
  { name: "Sint-Mëràin", type: "EXPRESS", totalDistance: 1515.26 },
  { name: "Punta Minaktosi Nof", type: "LOCAL", totalDistance: 1572.02 },
  { name: "Punta Minaktosi", type: "LTD_EXPRESS", totalDistance: 1613.02 },
  { name: "Punta Minaktosi Nof-Ves", type: "LOCAL", totalDistance: 1636.67 },
  { name: "Punta Minaktosi Ves", type: "LOCAL", totalDistance: 1681.61 },
  { name: "Monto Punto Mis", type: "EXPRESS", totalDistance: 1711.57 },
  { name: "Punto Mis Sof", type: "LOCAL", totalDistance: 1735.22 },
  { name: "Punto Mis", type: "LTD_EXPRESS", totalDistance: 1768.33 },
  { name: "Punto Mes Ves", type: "LOCAL", totalDistance: 1797.5 },
  { name: "Talliâche", type: "EXPRESS", totalDistance: 1838.5 },
  { name: "Talliâche-ves", type: "LOCAL", totalDistance: 1864.52 },
  { name: "Mällô", type: "LTD_LOCAL", totalDistance: 1893.69 },
  { name: "Ban-est", type: "LOCAL", totalDistance: 1942.57 },
  { name: "Ban", type: "LTD_EXPRESS", totalDistance: 2005.64 },
  { name: "Ban-ves", type: "LOCAL", totalDistance: 2045.06 },
  { name: "Nœuïï", type: "LTD_LOCAL", totalDistance: 2089.21 },
  { name: "Meno Cliffs NP", type: "EXPRESS", totalDistance: 2142.03 },
  { name: "Meno-fön-est", type: "LOCAL", totalDistance: 2187.76 },
  { name: "Meno-est", type: "LOCAL", totalDistance: 2228.76 },
  { name: "Meno", type: "LTD_EXPRESS", totalDistance: 2276.06 },
  { name: "Meno-ves", type: "LOCAL", totalDistance: 2332.82 },
  { name: "Meno-fön-ves", type: "LTD_LOCAL", totalDistance: 2362.78 },
  { name: "Barlo-fön-est", type: "LOCAL", totalDistance: 2397.47 },
  { name: "Barlo-est", type: "LOCAL", totalDistance: 2429.01 },
  { name: "Barlo", type: "LTD_EXPRESS", totalDistance: 2468.43 },
  { name: "Barlo-ves", type: "LOCAL", totalDistance: 2494.45 },
  { name: "Barlo-nof-ves", type: "EXPRESS", totalDistance: 2522.83 },
  { name: "Qicto-sof-est", type: "LOCAL", totalDistance: 2559.88 },
  { name: "Qicto-sof", type: "LOCAL", totalDistance: 2600.09 },
  { name: "Qicto", type: "LTD_EXPRESS", totalDistance: 2637.14 },
  { name: "Qicto-ves", type: "LOCAL", totalDistance: 2678.14 },
  { name: "Dino-fön-est", type: "LOCAL", totalDistance: 2708.89 },
  { name: "Dino-est", type: "LOCAL", totalDistance: 2738.06 },
  { name: "Dino", type: "LTD_EXPRESS", totalDistance: 2769.6 },
  { name: "Dino-nof", type: "LOCAL", totalDistance: 2809.02 },
  { name: "Dino Bay NP", type: "EXPRESS", totalDistance: 2835.04 },
  { name: "Rennee", type: "LTD_LOCAL", totalDistance: 2866.58 },
  { name: "Rennee-nof", type: "LOCAL", totalDistance: 2924.13 },
  { name: "Sävínœa", type: "EXPRESS", totalDistance: 2953.3 },
  { name: "Marlorto-sof-ves", type: "LOCAL", totalDistance: 2981.68 },
  { name: "Marlorto", type: "LTD_EXPRESS", totalDistance: 3023.46 },
  { name: "Marlorto-nof", type: "LOCAL", totalDistance: 3064.46 },
  { name: "Montisolle", type: "EXPRESS", totalDistance: 3091.26 },
  { name: "Bay-sof", type: "LOCAL", totalDistance: 3113.33 },
  { name: "Bay", type: "LTD_EXPRESS", totalDistance: 3160.63 },
  { name: "Misnan", type: "LTD_EXPRESS", totalDistance: 3274.95 },
  { name: "Noisey-on-tön", type: "LTD_LOCAL", totalDistance: 3412.92 },
  { name: "Bôürbolns", type: "LOCAL", totalDistance: 3436.57 },
  { name: "Métiers", type: "LTD_LOCAL", totalDistance: 3464.95 },
  { name: "Méttërest", type: "EXPRESS", totalDistance: 3490.97 },
  { name: "Metak-fön-sof-ves", type: "LOCAL", totalDistance: 3532.75 },
  { name: "Metak-sof-ves", type: "LOCAL", totalDistance: 3568.23 },
  { name: "Metak", type: "LTD_EXPRESS", totalDistance: 3619.47 },
  { name: "Metak-est", type: "LOCAL", totalDistance: 3658.89 },
  { name: "Mahurt", type: "LTD_LOCAL", totalDistance: 3714.08 },
  { name: "Mahurt-est", type: "LOCAL", totalDistance: 3747.19 },
  { name: "Meur", type: "EXPRESS", totalDistance: 3782.67 },
  { name: "Mis-ves", type: "LOCAL", totalDistance: 3849.68 },
  { name: "Mis", type: "LTD_EXPRESS", totalDistance: 3877.27 },
  { name: "Mis-est", type: "LOCAL", totalDistance: 3928.51 },
  { name: "Mis-nof-est", type: "LOCAL", totalDistance: 3975.81 },
  { name: "Ruten", type: "EXPRESS", totalDistance: 4038.88 },
  { name: "Industrial District", type: "LTD_LOCAL", totalDistance: 4070.42 },
  { name: "Mt. Set", type: "LOCAL", totalDistance: 4109.84 },
  { name: "Set West", type: "LTD_EXPRESS", totalDistance: 4168.97 },
  { name: "Brent River", type: "EXPRESS", totalDistance: 4217.85 },
  { name: "East Brent River", type: "LOCAL", totalDistance: 4284.86 },
  { name: "Set (Looped)", type: "LTD_EXPRESS", totalDistance: 4383.41 }
];

// Build lookup map for station data
const stationDataMap = {};
STATION_DATA.forEach(st => {
  stationDataMap[st.name] = st;
  // Also add by stationId (normalized)
  stationDataMap[normalizeName(st.name)] = st;
});

/* ================================================================
   FARE CALCULATION FUNCTIONS
   ================================================================ */

// Get total distance for a station by name or ID
function getStationTotalDistance(stationId) {
  // Try to find by station name first
  const station = stationLookup[stationId];
  if (!station) return null;
  
  const stationName = station.name;
  const data = stationDataMap[stationName] || stationDataMap[normalizeName(stationName)];
  return data ? data.totalDistance : null;
}

// Get station type for a station
function getStationType(stationId) {
  const station = stationLookup[stationId];
  if (!station) return 'LOCAL';
  return station.type || 'LOCAL';
}

// Calculate the shorter distance between two points on the loop
function calculateShorterDistance(distA, distB) {
  if (distA === null || distB === null) return null;
  
  const totalLoop = FARE_CONSTANTS.TOTAL_LOOP;
  
  // Distance going forward (clockwise)
  let forwardDist = distB - distA;
  if (forwardDist < 0) forwardDist += totalLoop;
  
  // Distance going backward (counter-clockwise)
  let backwardDist = distA - distB;
  if (backwardDist < 0) backwardDist += totalLoop;
  
  // Return the shorter distance, capped at half loop
  let shorterDist = Math.min(forwardDist, backwardDist);
  
  // Cap at half loop
  if (shorterDist > FARE_CONSTANTS.HALF_LOOP_CAP) {
    shorterDist = FARE_CONSTANTS.HALF_LOOP_CAP;
  }
  
  return Math.round(shorterDist * 100) / 100; // Round to 2 decimal places
}

// Calculate fare for a single-leg journey (no transfers)
function calculateSingleLegFare(fromStationId, toStationId, trainType, className) {
  const fromDist = getStationTotalDistance(fromStationId);
  const toDist = getStationTotalDistance(toStationId);
  
  if (fromDist === null || toDist === null) return null;
  
  // Calculate shorter distance
  const distance = calculateShorterDistance(fromDist, toDist);
  
  // Get multipliers
  const classMult = FARE_CONSTANTS.CLASS_MULTIPLIERS[className] || 1.00;
  const trainMult = FARE_CONSTANTS.TRAIN_MULTIPLIERS[trainType] || 1.00;
  
  // Get origin station surcharge
  const originType = getStationType(fromStationId);
  const surcharge = FARE_CONSTANTS.STATION_SURCHARGES[originType] || 0;
  
  // Calculate base fare
  let fare = FARE_CONSTANTS.BASE_RATE * distance * classMult * trainMult;
  
  // Apply minimum fare
  if (fare < FARE_CONSTANTS.MINIMUM_FARE) {
    fare = FARE_CONSTANTS.MINIMUM_FARE;
  }
  
  // Add surcharge
  fare += surcharge;
  
  // Round to nearest 0.5 DSD
  fare = Math.round(fare * 2) / 2;
  
  return {
    distance: distance,
    fare: fare,
    breakdown: {
      baseRate: FARE_CONSTANTS.BASE_RATE,
      distance: distance,
      classMultiplier: classMult,
      trainMultiplier: trainMult,
      surcharge: surcharge,
      minimumApplied: (FARE_CONSTANTS.BASE_RATE * distance * classMult * trainMult) < FARE_CONSTANTS.MINIMUM_FARE
    }
  };
}

// Calculate fare for a journey with transfers
function calculateTransferFare(journey, className) {
  if (!journey || !journey.legs || journey.legs.length === 0) return null;
  
  const fromStationId = journey.legs[0].from.stationId;
  const toStationId = journey.legs[journey.legs.length - 1].to.stationId;
  
  const fromDist = getStationTotalDistance(fromStationId);
  const toDist = getStationTotalDistance(toStationId);
  
  if (fromDist === null || toDist === null) return null;
  
  // Calculate total shorter distance
  const totalDistance = calculateShorterDistance(fromDist, toDist);
  
  // Calculate weighted train multiplier
  let totalWeightedDistance = 0;
  let totalSegmentDistance = 0;
  
  journey.legs.forEach(leg => {
    const legFromDist = getStationTotalDistance(leg.from.stationId);
    const legToDist = getStationTotalDistance(leg.to.stationId);
    
    if (legFromDist !== null && legToDist !== null) {
      const legDistance = calculateShorterDistance(legFromDist, legToDist);
      const trainMult = FARE_CONSTANTS.TRAIN_MULTIPLIERS[leg.train.serviceType] || 1.00;
      
      totalWeightedDistance += legDistance * trainMult;
      totalSegmentDistance += legDistance;
    }
  });
  
  const weightedTrainMult = totalSegmentDistance > 0 
    ? totalWeightedDistance / totalSegmentDistance 
    : 1.00;
  
  // Get class multiplier (highest used)
  const classMult = FARE_CONSTANTS.CLASS_MULTIPLIERS[className] || 1.00;
  
  // Get origin station surcharge
  const originType = getStationType(fromStationId);
  const surcharge = FARE_CONSTANTS.STATION_SURCHARGES[originType] || 0;
  
  // Calculate fare
  let fare = FARE_CONSTANTS.BASE_RATE * totalDistance * classMult * weightedTrainMult;
  
  // Apply minimum fare
  if (fare < FARE_CONSTANTS.MINIMUM_FARE) {
    fare = FARE_CONSTANTS.MINIMUM_FARE;
  }
  
  // Add surcharge
  fare += surcharge;
  
  // Round to nearest 0.5 DSD
  fare = Math.round(fare * 2) / 2;
  
  return {
    distance: totalDistance,
    fare: fare,
    weightedTrainMultiplier: Math.round(weightedTrainMult * 1000) / 1000,
    breakdown: {
      baseRate: FARE_CONSTANTS.BASE_RATE,
      distance: totalDistance,
      classMultiplier: classMult,
      weightedTrainMultiplier: Math.round(weightedTrainMult * 1000) / 1000,
      surcharge: surcharge,
      minimumApplied: (FARE_CONSTANTS.BASE_RATE * totalDistance * classMult * weightedTrainMult) < FARE_CONSTANTS.MINIMUM_FARE
    }
  };
}

// Format fare display
function formatFareDisplay(fareResult, className, trainType) {
  if (!fareResult) return '';
  
  const dsd = fareResult.fare;
  const sgd = Math.round(dsd * 2 * 100) / 100;
  
  return `
    <div class="fare-display">
      <div class="fare-amount">
        <span class="fare-value">${dsd} DSD</span>
        <span class="fare-sgd">(≈ ${sgd} SGD)</span>
      </div>
      <div class="fare-details">
        <small>
          ${fareResult.distance} km • ${className} class • ${trainType.replace(/_/g, ' ')}
          ${fareResult.breakdown.minimumApplied ? ' • Minimum fare applied' : ''}
        </small>
      </div>
    </div>
  `;
}

/* ---------------- RESULTS TABLE WITH FARE ---------------- */
function renderResultsTable(results, fromSt, toSt) {
  const resultsDiv = document.getElementById("results");

  let html = `
    <div class="results-summary">
      Found ${results.length} journey${results.length !== 1 ? 's' : ''} from ${fromSt.name} to ${toSt.name}
    </div>
    <table class="results-table">
      <thead>
        <tr>
          <th>Route</th>
          <th>Departure</th>
          <th>Arrival</th>
          <th>Duration</th>
          <th>Changes</th>
          <th>Details</th>
          <th>Fare (Third)</th>
          <th>Buy</th>
        </tr>
      </thead>
      <tbody>
  `;

  results.forEach((journey) => {
    const trainIds = journey.legs.map(l => l.train.trainId);
    const departureTime = journey.departureTime;
    const arrivalTime = journey.arrivalTime;
    const d = journey.durationSec;
    const duration = `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
    const stopovers = journey.stopovers;
    
    // Get the highest train type for fare calculation
    const trainTypes = journey.legs.map(l => l.train.serviceType);
    const highestTrainType = trainTypes.reduce((highest, current) => {
      const currentMult = FARE_CONSTANTS.TRAIN_MULTIPLIERS[current] || 1;
      const highestMult = FARE_CONSTANTS.TRAIN_MULTIPLIERS[highest] || 1;
      return currentMult > highestMult ? current : highest;
    }, 'LOCAL');
    
    // Calculate fare for Third class (used for display, but real fare will be per chosen class)
    let fareResult;
    if (stopovers === 0) {
      fareResult = calculateSingleLegFare(
        journey.legs[0].from.stationId,
        journey.legs[0].to.stationId,
        highestTrainType,
        'Third'
      );
    } else {
      fareResult = calculateTransferFare(journey, 'Third');
    }
    
    let detailsHtml = '';
    if (stopovers === 0) {
      detailsHtml = 'Direct';
    } else {
      const details = [];
      for (let i = 0; i < journey.legs.length - 1; i++) {
        const currentLeg = journey.legs[i];
        const nextLeg = journey.legs[i + 1];
        const stationName = stationLookup[currentLeg.to.stationId]?.name || currentLeg.to.stationId;
        let layoverSec;
        if (journey.layoverSec !== undefined) {
          layoverSec = Array.isArray(journey.layoverSec)
            ? journey.layoverSec[i]
            : journey.layoverSec;
        } else {
          let arrSec = toSeconds(currentLeg.to.arrival, currentLeg.train.trainId);
          let depSec = toSeconds(nextLeg.from.departure, nextLeg.train.trainId);
          if (depSec < arrSec) depSec += 86400;
          layoverSec = depSec - arrSec;
        }
        details.push(`Change at ${stationName} (${formatLayover(layoverSec)})`);
      }
      detailsHtml = details.join(' → ');
    }

    const routeDetails = journey.legs.map((leg) => {
      const type = leg.train.serviceType.replaceAll("_", " ");
      return `${leg.train.trainId}<br><small>(${type})</small>`;
    }).join(' → ');

    const rowClass = stopovers === 0 ? 'direct-journey' : 'transfer-journey';

    const legWaypoints = journey.legs.map(l =>
      `${l.from.stationId}|${l.from.sequence}|${l.to.stationId}|${l.to.sequence}`
    ).join(',');

    // Format fare cell
    const fareCell = fareResult 
      ? `<span class="fare-value-cell">${fareResult.fare} DSD</span><br><small class="fare-sgd-cell">≈ ${Math.round(fareResult.fare * 2 * 100) / 100} SGD</small>`
      : '<span style="color: #95a5a6;">—</span>';

    // Buy button (only visible if user is logged in)
    const buyButton = currentUser 
      ? `<button class="buy-ticket-btn" 
               data-journey='${JSON.stringify(journey)}'
               data-from="${journey.legs[0].from.stationId}"
               data-to="${journey.legs[journey.legs.length-1].to.stationId}"
               data-departure="${departureTime}"
               data-train="${trainIds[0]}"
               data-type="${highestTrainType}"
               style="padding:4px 8px; background:#4caf50; color:white; border:none; border-radius:4px; cursor:pointer;">🎟️ Buy</button>`
      : '<span style="color:#95a5a6;">Login to buy</span>';

    html += `
      <tr class="clickable ${rowClass}" 
          data-train-ids="${trainIds.join(',')}" 
          data-leg-waypoints="${legWaypoints}"
          data-from="${journey.legs[0].from.stationId}" 
          data-to="${journey.legs[journey.legs.length - 1].to.stationId}">
        <td>${routeDetails}</td>
        <td>${departureTime}</td>
        <td>${arrivalTime}</td>
        <td><strong>${duration}</strong></td>
        <td>${stopovers}</td>
        <td>${detailsHtml}</td>
        <td class="fare-cell">${fareCell}</td>
        <td class="buy-cell">${buyButton}</td>
      </tr>
    `;
  });

  html += "</tbody></table>";
  resultsDiv.innerHTML = html;

  // Add click listeners for row expansion
  document.querySelectorAll(".clickable").forEach(row => {
    row.onclick = (e) => {
      // Prevent opening the timetable if the click was on the buy button
      if (e.target.classList && e.target.classList.contains('buy-ticket-btn')) return;
      const trainIds = row.dataset.trainIds.split(",");
      const legWaypoints = row.dataset.legWaypoints
        ? row.dataset.legWaypoints.split(',').map(w => {
            const [fromId, fromSeq, toId, toSeq] = w.split('|');
            return { from: fromId, fromSeq: Number(fromSeq), to: toId, toSeq: Number(toSeq) };
          })
        : null;
      const fromStation = row.dataset.from;
      const toStation = row.dataset.to;
      showFullTimetable(trainIds, fromStation, toStation, legWaypoints);
    };
  });

  // Add buy button listeners
  document.querySelectorAll('.buy-ticket-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const journey = JSON.parse(btn.dataset.journey);
      const from = btn.dataset.from;
      const to = btn.dataset.to;
      const departure = btn.dataset.departure;
      const trainId = btn.dataset.train;
      const serviceType = btn.dataset.type;
      openTicketBooking(journey, from, to, departure, trainId, serviceType);
    });
  });
}

/* ---------------- FULL TIMETABLE ---------------- */
function showFullTimetable(trainIds, fromStation, toStation, legWaypoints) {
  const panel = document.getElementById("timetablePanel");
  if (!panel) return;
  
  panel.innerHTML = "";

  trainIds.forEach((trainId, index) => {
    const train = timetableData.trains.find(t => t.trainId === trainId);
    if (!train) {
      panel.innerHTML += `<p>Train ${trainId} not found</p>`;
      return;
    }
    
    const stops = stopsByTrain[trainId];
    if (!stops || stops.length === 0) {
      panel.innerHTML += `<p>No stops found for train ${trainId}</p>`;
      return;
    }

    let highlightStartStation = null;
    let highlightEndStation = null;
    let highlightStartSeq = null;
    let highlightEndSeq = null;

    if (legWaypoints && legWaypoints[index]) {
      highlightStartStation = legWaypoints[index].from;
      highlightEndStation = legWaypoints[index].to;
      highlightStartSeq = legWaypoints[index].fromSeq;
      highlightEndSeq = legWaypoints[index].toSeq;
    } else if (trainIds.length === 1) {
      highlightStartStation = fromStation;
      highlightEndStation = toStation;
    } else if (index === 0) {
      highlightStartStation = fromStation;
      highlightEndStation = stops[stops.length - 1]?.stationId;
    } else if (index === trainIds.length - 1) {
      highlightStartStation = stops[0]?.stationId;
      highlightEndStation = toStation;
    }
    
    let html = `
      <div class="train-timetable">
      <h3>${escapeHtml(train.trainId)} – ${escapeHtml(train.serviceType?.replace(/_/g, " ") || "Unknown")} ${train.direction ? '(' + train.direction + ')' : ''}</h3>
      <table class="timetable-table">
        <thead>
          <tr><th>#</th><th>Station</th><th>Arrival</th><th>Departure</th><th>Platform</th></tr>
        </thead>
        <tbody>
    `;

    let highlightActive = false;
    
    stops.forEach((s, i) => {
      const isStart = highlightStartSeq !== null && highlightStartStation !== null
        ? (s.sequence === highlightStartSeq || s.stationId === highlightStartStation)
        : (s.stationId === highlightStartStation);
      const isEnd = highlightEndSeq !== null && highlightEndStation !== null
        ? (s.sequence === highlightEndSeq || s.stationId === highlightEndStation)
        : (s.stationId === highlightEndStation);

      if (isStart) highlightActive = true;
      
      const rowStyle = highlightActive ? "style='background: var(--accent, #ff9800); color: white; font-weight: bold;'" : "";
      const stationName = stationLookup[s.stationId]?.name || s.stationId;
      const platform = getPlatformForStop(s);
      
      html += `
        <tr ${rowStyle}>
          <td>${i + 1}</td>
          <td>${escapeHtml(stationName)}</td>
          <td>${s.arrival || "-"}</td>
          <td>${s.departure || "-"}</td>
          <td>${platform}</td>
        </tr>
      `;
      
      if (isEnd) highlightActive = false;
    });

    html += "</tbody></table></div>";
    panel.innerHTML += html;
  });

  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: 'smooth' });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

// Train number search
document.getElementById("trainSearchBtn").onclick = () => {
  if (!timetableData) return;

  const trainIdRaw = document.getElementById("trainIdInput").value.trim();
  if (!trainIdRaw) return;

  const trainId = normalizeName(trainIdRaw);
  const train = timetableData.trains.find(t => t.trainId === trainId);

  const resultsDiv = document.getElementById("results");
  const loading = document.getElementById("loading");
  const panel = document.getElementById("timetablePanel");

  resultsDiv.innerHTML = "";
  panel.classList.add("hidden");
  loading.classList.remove("hidden");

  setTimeout(() => {
    if (!train || !stopsByTrain[trainId] || stopsByTrain[trainId].length === 0) {
      loading.classList.add("hidden");
      resultsDiv.innerHTML = "<p>No train found with that number.</p>";
      return;
    }

    loading.classList.add("hidden");

    const firstStation = stopsByTrain[trainId][0].stationId;
    const lastStation = stopsByTrain[trainId][stopsByTrain[trainId].length - 1].stationId;
    showFullTimetable([trainId], firstStation, lastStation);
  }, 100);
};

/* ---------------- STATION BOARD ---------------- */
function dwellSeconds(stop) {
  if (!stop.arrival || !stop.departure) return null;
  const diff = toSeconds(stop.departure) - toSeconds(stop.arrival);
  return diff < 0 ? diff + 86400 : diff;
}

document.getElementById("boardSearchBtn").onclick = () => {
  if (!timetableData) return;

  const stationId = document.getElementById("boardStation").value;
  const resultsDiv = document.getElementById("results");
  const loading = document.getElementById("loading");
  const panel = document.getElementById("timetablePanel");

  resultsDiv.innerHTML = "";
  panel.classList.add("hidden");
  loading.classList.remove("hidden");

  setTimeout(() => {
    // Collect stops from ALL alias stations
    const aliasIds = allAliasIds(stationId);
    let allStops = [];
    aliasIds.forEach(id => {
      const stops = stopsByStation[id] || [];
      allStops = allStops.concat(stops);
    });

    if (!allStops || allStops.length === 0) {
      loading.classList.add("hidden");
      resultsDiv.innerHTML = "<p>No services found for this station.</p>";
      return;
    }

    // Separate arrivals and departures
    const arrivals = [];
    const departures = [];
    
    allStops.forEach(stop => {
      const train = timetableData.trains.find(t => t.trainId === stop.trainId);
      if (!train) return;
      
      const trainStops = stopsByTrain[stop.trainId];
      if (!trainStops || trainStops.length === 0) return;
      
      const firstStop = trainStops[0];
      const lastStop = trainStops[trainStops.length - 1];
      const originName = stationLookup[firstStop.stationId]?.name || firstStop.stationId;
      const terminusName = stationLookup[lastStop.stationId]?.name || lastStop.stationId;
      const dwell = dwellSeconds(stop);
      const platform = getPlatformForStop(stop);
      
      // Check if there's a next stop after this one
      const hasNextStop = trainStops.some(s => s.sequence > stop.sequence);
      
      const rowData = {
        trainId: stop.trainId,
        serviceType: train.serviceType.replaceAll("_", " "),
        direction: train.direction,
        origin: originName,
        destination: terminusName,
        arrival: stop.arrival || "—",
        departure: stop.departure || "—",
        platform: platform,
        dwell: dwell !== null ? dwell + "s" : "—",
        sortKey: toSeconds(stop.arrival || stop.departure)
      };
      
      if (hasNextStop) {
        // Train continues after this stop = DEPARTURE
        departures.push(rowData);
      } else {
        // No next stop = train terminates here = ARRIVAL
        arrivals.push(rowData);
      }
    });
    
    // Sort both arrays by time
    arrivals.sort((a, b) => a.sortKey - b.sortKey);
    departures.sort((a, b) => a.sortKey - b.sortKey);
    
    loading.classList.add("hidden");
    renderBoardTableWithSections(arrivals, departures, stationAliases[stationId] || stationLookup[stationId]?.name || "Station");
  }, 150);
};

function renderBoardTableWithSections(arrivals, departures, stationName) {
  const resultsDiv = document.getElementById("results");

  let html = `
    <div class="board-header">
      <span class="board-station-name">${stationName}</span>
      <span class="board-count">Departures: ${departures.length} | Arrivals: ${arrivals.length} | Total: ${departures.length + arrivals.length}</span>
    </div>
  `;
  
  // Departures section
  if (departures.length > 0) {
    html += `
      <h3 style="margin: 20px 0 10px 0; color: var(--accent);">🚆 Departures</h3>
      <table class="results-table board-table">
        <thead>
          <tr>
            <th>Train</th>
            <th>Type</th>
            <th>Dir</th>
            <th>To</th>
            <th>Departure</th>
            <th>Platform</th>
            <th>Dwell</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    departures.forEach(r => {
      const dirClass = r.direction === "CW" ? "dir-cw" : "dir-ccw";
      html += `
        <tr>
          <td><span class="train-badge">${r.trainId}</span></td>
          <td class="type-cell">${r.serviceType}</td>
          <td><span class="dir-badge ${dirClass}">${r.direction}</span></td>
          <td>${r.destination}</td>
          <td class="time-cell"><strong>${r.departure}</strong></td>
          <td><strong>P${r.platform}</strong></td>
          <td class="dwell-cell">${r.dwell}</td>
        </tr>
      `;
    });
    
    html += `</tbody></table>`;
  }
  
  // Arrivals section
  if (arrivals.length > 0) {
    html += `
      <h3 style="margin: 20px 0 10px 0; color: var(--success);">🟢 Arrivals</h3>
      <table class="results-table board-table">
        <thead>
          <tr>
            <th>Train</th>
            <th>Type</th>
            <th>Dir</th>
            <th>From</th>
            <th>Arrival</th>
            <th>Platform</th>
            <th>Dwell</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    arrivals.forEach(r => {
      const dirClass = r.direction === "CW" ? "dir-cw" : "dir-ccw";
      html += `
        <tr>
          <td><span class="train-badge">${r.trainId}</span></td>
          <td class="type-cell">${r.serviceType}</td>
          <td><span class="dir-badge ${dirClass}">${r.direction}</span></td>
          <td>${r.origin}</td>
          <td class="time-cell"><strong>${r.arrival}</strong></td>
          <td><strong>P${r.platform}</strong></td>
          <td class="dwell-cell">${r.dwell}</td>
        </tr>
      `;
    });
    
    html += `</tbody></table>`;
  }
  
  if (arrivals.length === 0 && departures.length === 0) {
    html += `<p style="text-align: center; padding: 20px;">No services found for this station.</p>`;
  }
  
  resultsDiv.innerHTML = html;
}

function renderBoardTable(rows, stationName) {
  const resultsDiv = document.getElementById("results");

  let html = `
    <div class="board-header">
      <span class="board-station-name">${stationName}</span>
      <span class="board-count">${rows.length} service${rows.length !== 1 ? "s" : ""}</span>
    </div>
    <table class="results-table board-table">
      <thead>
        <tr>
          <th>Train</th>
          <th>Type</th>
          <th>Dir</th>
          <th>From</th>
          <th>To</th>
          <th>Arrival</th>
          <th>Departure</th>
          <th>Dwell</th>
        </tr>
      </thead>
      <tbody>
  `;

  rows.forEach(r => {
    const dirClass = r.direction === "CW" ? "dir-cw" : "dir-ccw";
    html += `
      <tr>
        <td><span class="train-badge">${r.trainId}</span></td>
        <td class="type-cell">${r.serviceType}</td>
        <td><span class="dir-badge ${dirClass}">${r.direction}</span></td>
        <td>${r.origin}</td>
        <td>${r.destination}</td>
        <td class="time-cell">${r.arrival}</td>
        <td class="time-cell">${r.departure}</td>
        <td class="dwell-cell">${r.dwell}</td>
      </tr>
    `;
  });

  html += "</tbody></table>";
  resultsDiv.innerHTML = html;
}

/* ================================================================
   FEATURE: HIGH-CONTRAST MODE
   ================================================================ */

(function() {
  const btn = document.getElementById('hcToggle');
  const HC_KEY = 'sc_high_contrast';

  function applyHC(on) {
    document.body.classList.toggle('high-contrast', on);
    btn.title = on ? 'Disable high-contrast mode' : 'Enable high-contrast mode';
    try { localStorage.setItem(HC_KEY, on ? '1' : '0'); } catch(e) {}
  }

  // Restore preference on load
  try {
    if (localStorage.getItem(HC_KEY) === '1') applyHC(true);
  } catch(e) {}

  btn.addEventListener('click', () => {
    applyHC(!document.body.classList.contains('high-contrast'));
  });
})();

/* ================================================================
   FEATURE: PRINT / EXPORT TIMETABLE
   ================================================================
   Adds a "Print / Export CSV" button bar above any results table.
   Called after every renderResultsTable / renderBoardTable /
   renderLiveDepartures so the buttons always appear fresh.
   ================================================================ */

function injectExportBar(contextLabel) {
  const resultsDiv = document.getElementById('results');
  if (!resultsDiv || !resultsDiv.firstElementChild) return;

  // Avoid double-injection
  if (resultsDiv.querySelector('.export-bar')) return;

  const bar = document.createElement('div');
  bar.className = 'export-bar';
  bar.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;';

  const printBtn = document.createElement('button');
  printBtn.className = 'export-btn';
  printBtn.textContent = '🖨 Print';
  printBtn.onclick = () => window.print();

  const csvBtn = document.createElement('button');
  csvBtn.className = 'export-btn';
  csvBtn.textContent = '⬇ Export CSV';
  csvBtn.onclick = () => exportTableAsCSV(contextLabel);

  bar.appendChild(printBtn);
  bar.appendChild(csvBtn);
  resultsDiv.insertBefore(bar, resultsDiv.firstElementChild);
}

function exportTableAsCSV(label) {
  const table = document.querySelector('#results table');
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('tr'));
  const lines = rows.map(row => {
    const cells = Array.from(row.querySelectorAll('th,td'));
    return cells.map(c => {
      // Get clean text, collapse whitespace
      const text = c.innerText.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      // Wrap in quotes if it contains commas or quotes
      return /[,"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(',');
  });

  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shore_connect_${(label || 'export').replace(/\s+/g,'_')}_${formatTime(getGMT12Seconds()).replace(':','')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ================================================================
   FEATURE: OCCUPANCY INDICATOR
   ================================================================
   Deterministically generates a per-train occupancy level from the
   trainId hash so it's stable across renders but looks realistic.
   ================================================================ */

function getOccupancy(trainId) {
  // Simple stable hash from trainId string
  let hash = 0;
  for (let i = 0; i < trainId.length; i++) {
    hash = (hash * 31 + trainId.charCodeAt(i)) & 0xffffffff;
  }
  // 3 carriages, each independently quiet/moderate/busy
  const carriages = [];
  for (let c = 0; c < 3; c++) {
    const val = Math.abs((hash >> (c * 8)) & 0xff) % 3; // 0=quiet,1=mod,2=busy
    carriages.push(val);
  }
  return carriages;
}

function renderOccupancyStrip(trainId) {
  const carriages = getOccupancy(trainId);
  const labels = ['Quiet', 'Moderate', 'Busy'];
  const classes = ['occ-quiet', 'occ-mod', 'occ-busy'];
  // Overall is the max
  const overall = Math.max(...carriages);
  const dots = carriages.map(c =>
    `<span class="occupancy-dot ${classes[c]}" title="Carriage: ${labels[c]}"></span>`
  ).join('');
  return `<span class="occupancy-strip">${dots}<span class="occupancy-label">${labels[overall]}</span></span>`;
}

/* ================================================================
   FEATURE: PLATFORM CHANGE FLASH
   ================================================================
   Tracks the last-known platform per train on the live board and
   flashes a row + badge when it changes between render cycles.
   ================================================================ */

const lastKnownPlatforms = {}; // trainId → platform number

function checkPlatformChanges(trainId, currentPlatform, row) {
  const prev = lastKnownPlatforms[trainId];
  lastKnownPlatforms[trainId] = currentPlatform;

  if (prev !== undefined && prev !== currentPlatform) {
    // Platform changed — flash the row
    row.classList.remove('platform-changed');
    // Trigger reflow so the animation restarts even if already applied
    void row.offsetWidth;
    row.classList.add('platform-changed');

    // Find the platform cell and annotate it
    const platformCell = row.querySelector('.platform-cell');
    if (platformCell) {
      platformCell.innerHTML =
        `<strong>P${currentPlatform}</strong>` +
        `<span class="platform-change-badge" title="Was P${prev}">P${prev}→P${currentPlatform}</span>`;
    }

    // Remove the flash class after animation completes (3 × 1.2s = 3.6s)
    setTimeout(() => row.classList.remove('platform-changed'), 3700);
    return true;
  }
  return false;
}

/* ================================================================
   FEATURE: DEPARTURE COUNTDOWN HUD
   ================================================================ */

let pinnedDeparture = null; // { trainId, destination, platform, departureTime }
let hudInterval = null;

function pinDeparture(dep) {
  pinnedDeparture = dep;
  document.getElementById('hudTrain').textContent = dep.trainId;
  document.getElementById('hudDest').textContent = `→ ${dep.destination}`;
  document.getElementById('hudPlatform').textContent = `Platform ${dep.platform}`;
  document.getElementById('pinnedHUD').classList.remove('hidden');
  updateHUD();
  if (hudInterval) clearInterval(hudInterval);
  hudInterval = setInterval(updateHUD, 1000);
}

function updateHUD() {
  if (!pinnedDeparture) return;
  const currentSeconds = getGMT12Seconds();
  const depSeconds = toSeconds(pinnedDeparture.departureTime);
  let diff = depSeconds - currentSeconds;
  if (diff < -43200) diff += 86400;

  const el = document.getElementById('hudCountdown');
  if (diff <= -60) {
    el.textContent = 'Departed';
    el.style.color = '#94a3b8';
  } else if (diff <= 0) {
    el.textContent = 'Now!';
    el.style.color = '#ff4466';
  } else if (diff < 60) {
    el.textContent = `${diff}s`;
    el.style.color = '#ff4466';
  } else if (diff < 3600) {
    const m = Math.floor(diff / 60), s = diff % 60;
    el.textContent = diff < 300 ? `${m}m ${s}s` : `${m}m`;
    el.style.color = diff < 300 ? '#ff8c00' : '#00ff88';
  } else {
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60);
    el.textContent = `${h}h ${m}m`;
    el.style.color = '#00ff88';
  }
}

document.getElementById('hudClose').addEventListener('click', () => {
  pinnedDeparture = null;
  clearInterval(hudInterval);
  hudInterval = null;
  document.getElementById('pinnedHUD').classList.add('hidden');
});

/* ================================================================
   PATCH: renderLiveDepartures — inject occupancy, platform cell
   class, pin button, and check platform changes
   ================================================================
   We monkey-patch the function defined earlier by redefining it
   after all helpers are available. The original is replaced wholesale
   with an enhanced version that calls the new helpers.
   ================================================================ */

renderLiveDepartures = function(stationId) {
  const resultsDiv = document.getElementById("results");
  const station = stationLookup[stationId];
  const currentSeconds = getGMT12Seconds();

  const allStops = stopsByStation[stationId] || [];
  const upcomingDepartures = allStops
    .filter(stop => {
      // Skip if this train terminates at this station (no departure)
      if (isTerminatingStop(stop, stop.trainId)) {
        return false;
      }
      // Skip if there's no departure time (arrival-only stop)
      if (!stop.departure || stop.departure === '—') {
        return false;
      }
      const depTime = toSeconds(stop.departure || stop.arrival);
      let timeDiff = depTime - currentSeconds;
      if (timeDiff < -43200) timeDiff += 86400;
      return timeDiff >= -60 && timeDiff <= 7200;
    })
    .map(stop => {
      const train = timetableData.trains.find(t => t.trainId === stop.trainId);
      const trainStops = stopsByTrain[stop.trainId];
      const origin = trainStops[0];
      const terminus = trainStops[trainStops.length - 1];
      let timeDiff = toSeconds(stop.departure || stop.arrival, stop.trainId) - currentSeconds;
      if (timeDiff < -43200) timeDiff += 86400;
      const platform = getPlatformForStop(stop);
      return {
        trainId: stop.trainId,
        serviceType: train ? train.serviceType.replaceAll("_", " ") : "—",
        direction: train ? train.direction : "—",
        origin: stationLookup[origin.stationId]?.name || origin.stationId,
        destination: stationLookup[terminus.stationId]?.name || terminus.stationId,
        departure: stop.departure || "—",
        arrival: stop.arrival || "—",
        platform: platform,
        timeDiff: timeDiff
      };
    })
    .sort((a, b) => a.timeDiff - b.timeDiff);

  const nowString = getGMT12Time().toISOString().replace('T', ' ').substring(0, 19);
  const syncStatus = atomicTimeSynced ? '⚛ Atomic Time' : '⏳ Local Time';

  let html = `
    <div class="live-board-container">
      <div class="live-board-header">
        <div class="live-board-title">
          <h2>${stationAliases[stationId] || station.name} - Live Departures</h2>
          <div class="live-clock-large">${nowString} GMT+12</div>
        </div>
        <div class="live-board-status">
          <span class="live-dot"></span> ${syncStatus} • ${upcomingDepartures.length} departures in next 2 hours
        </div>
      </div>
    <table class="results-table live-board-table">
      <thead>
        <tr>
          <th>Scheduled</th>
          <th>Countdown</th>
          <th>Train</th>
          <th>Type</th>
          <th>To</th>
          <th>Platform</th>
          <th>Occupancy</th>
          <th>Waiting Room</th>
          <th>Status</th>
          <th>Pin</th>
        </tr>
      </thead>
      <tbody>
  `;

  if (upcomingDepartures.length === 0) {
    html += `<tr><td colspan="10" style="text-align:center;padding:20px;color:#95a5a6;">No departures in the next 2 hours</td></tr>`;
  } else {
    upcomingDepartures.forEach(dep => {
      const waitingRoom = getPlatformWaitingRoom(stationId, dep.platform);
      const dirClass = dep.direction === "CW" ? "dir-cw" : "dir-ccw";
      const td = dep.timeDiff;

      let countdownText, countdownColor;
      if (td <= -60)      { countdownText = 'Departed'; countdownColor = '#95a5a6'; }
      else if (td <= 0)   { countdownText = 'Now'; countdownColor = '#e74c3c'; }
      else if (td < 60)   { countdownText = `${td}s`; countdownColor = '#e74c3c'; }
      else if (td < 300)  { countdownText = `${Math.floor(td/60)}m ${td%60}s`; countdownColor = '#e67e22'; }
      else if (td < 3600) { countdownText = `${Math.floor(td/60)}m`; countdownColor = '#27ae60'; }
      else { countdownText = `${Math.floor(td/3600)}h ${Math.floor((td%3600)/60)}m`; countdownColor = '#3498db'; }

      const departureSeconds = toSeconds(dep.departure);
      let ticketCheckStart = departureSeconds - 1800;
      if (ticketCheckStart < 0) ticketCheckStart += 86400;

      let trainStatus = '', ticketInfo = '', statusClass = '';
      if (td > 1800)       { trainStatus='SCHEDULED'; ticketInfo=`Ticket check: ${formatTime(ticketCheckStart)}`; statusClass='status-ontime'; }
      else if (td > 120)   { trainStatus='ON TIME';   ticketInfo=`Ticket closes: ${formatTime(departureSeconds-30)}`; statusClass='status-ontime'; }
      else if (td > 60)    { trainStatus='BOARDING';  ticketInfo=`Ticket closes: ${formatTime(departureSeconds-30)}`; statusClass='status-boarding'; }
      else if (td > 0)     { trainStatus='FINAL CALL';ticketInfo=`⚠️ Closes at ${formatTime(departureSeconds-30)}!`; statusClass='status-final_call'; }
      else if (td > -60)   { trainStatus='DEPARTING'; ticketInfo='Ticket closed'; statusClass='status-departing'; }
      else                 { trainStatus='DEPARTED';  ticketInfo='Train has departed'; statusClass='status-departed'; }

      const occHtml = renderOccupancyStrip(dep.trainId);
      const pinBtn = td > -60
        ? `<button class="export-btn" style="padding:3px 8px;font-size:0.75rem;" onclick="pinDeparture({trainId:'${dep.trainId}',destination:'${dep.destination.replace(/'/g,"\\'")}',platform:'${dep.platform}',departureTime:'${dep.departure}'})">📌</button>`
        : '';

      html += `
        <tr class="live-departure-row" data-departure-time="${dep.departure}" data-train-id="${dep.trainId}" data-platform="${dep.platform}">
          <td class="time-cell">${dep.departure}</td>
          <td class="countdown-cell"><span class="countdown" style="color:${countdownColor}">${countdownText}</span></td>
          <td><span class="train-badge">${dep.trainId}</span></td>
          <td class="type-cell">${dep.serviceType}</td>
          <td>${dep.destination}<br><small><span class="dir-badge ${dirClass}">${dep.direction}</span></small></td>
          <td class="platform-cell"><strong>P${dep.platform}</strong></td>
          <td>${occHtml}</td>
          <td>${waitingRoom}</td>
          <td><span class="status-badge ${statusClass}" style="white-space:normal;line-height:1.3">${trainStatus}<br><small class="ticket-info">${ticketInfo}</small></span></td>
          <td>${pinBtn}</td>
        </tr>
      `;
    });
  }

  html += `</tbody></table>
    <div class="live-board-footer">
      <small>Updates every second • ${syncStatus} • Last updated: ${nowString}</small>
    </div></div>`;

  resultsDiv.innerHTML = html;
  injectExportBar(`live_${station.name}`);

  // Check platform changes now that DOM is rebuilt
  document.querySelectorAll('.live-departure-row').forEach(row => {
    const trainId = row.dataset.trainId;
    const platform = parseInt(row.dataset.platform, 10);
    if (trainId && platform) checkPlatformChanges(trainId, platform, row);
  });
};

/* Also inject export bar after static board renders */
const _origRenderBoardTable = renderBoardTable;
renderBoardTable = function(rows, stationName) {
  _origRenderBoardTable(rows, stationName);
  injectExportBar(stationName);
};

/* ================================================================
   FEATURE: INTERACTIVE ROUTE MAP
   ================================================================
   Builds an SVG ring-line schematic from timetableData.stations.
   Stations are positioned on a circle; clicking jumps to live board.
   ================================================================ */

function renderRouteMap() {
  if (!timetableData) return;

  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = '';

  const stations = timetableData.stations;
  if (stations.length === 0) return;

  // ── Segment distances (km) in ring order ────────────────────────────
  // Each value is the distance FROM the previous station TO this one.
  const SEGMENT_KM = {
    'Set': 0,
    'Set South': 74.9,
    'Franklin Airport': 36.27,
    'Galaxy': 39.42,
    'Galaxy South': 84.36,
    'Réstön': 47.3,
    'Réstön South': 28.38,
    'Bay of Set': 48.09,
    'Taśtök North': 29.17,
    'Taśtök': 19.71,
    'Taśtök South': 29.17,
    'Jeso North': 33.11,
    'Jeso': 63.86,
    'Jeso South': 23.65,
    'Astóńksér': 29.17,
    'Astóńksér-Siëra': 31.54,
    'Siëra': 37.05,
    'Siëña': 51.24,
    'Ukarënósétpö': 30.75,
    'Ukarënósétpö-Sytöul': 22.07,
    'Sytöul': 25.23,
    'Dëstra-nof': 23.65,
    'Dëstra': 21.29,
    'Dëstra-sof': 22.86,
    'Viéräst': 19.71,
    'Peioms': 43.36,
    'Lobset-nof': 46.51,
    'Lobset': 70.95,
    'Lobset-sof': 45.73,
    'Noisi-parl': 41,
    'Noisi-de-touché': 26.02,
    'Chagny-on-bochy': 22.86,
    'Sin-nof': 39.42,
    'Sin': 57.55,
    'Sin-sof': 43.36,
    'Læmëré': 41.78,
    'Læmëré-sof': 23.65,
    'Châleté': 56.76,
    'Cïtêrè': 35.48,
    'Sint-Mëràin': 48.88,
    'Punta Minaktosi Nof': 56.76,
    'Punta Minaktosi': 41,
    'Punta Minaktosi Nof-Ves': 23.65,
    'Punta Minaktosi Ves': 44.94,
    'Monto Punto Mis': 29.96,
    'Punto Mis Sof': 23.65,
    'Punto Mis': 33.11,
    'Punto Mes Ves': 29.17,
    'Talliâche': 41,
    'Talliâche-ves': 26.02,
    'Mällô': 29.17,
    'Ban-est': 48.88,
    'Ban': 63.07,
    'Ban-ves': 39.42,
    'Nœuïï': 44.15,
    'Meno Cliffs NP': 52.82,
    'Meno-fön-est': 45.73,
    'Meno-est': 41,
    'Meno': 47.3,
    'Meno-ves': 56.76,
    'Meno-fön-ves': 29.96,
    'Barlo-fön-est': 34.69,
    'Barlo-est': 31.54,
    'Barlo': 39.42,
    'Barlo-ves': 26.02,
    'Barlo-nof-ves': 28.38,
    'Qicto-sof-est': 37.05,
    'Qicto-sof': 40.21,
    'Qicto': 37.05,
    'Qicto-ves': 41,
    'Dino-fön-est': 30.75,
    'Dino-est': 29.17,
    'Dino': 31.54,
    'Dino-nof': 39.42,
    'Dino Bay NP': 26.02,
    'Rennee': 31.54,
    'Rennee-nof': 57.55,
    'Sävínœa': 29.17,
    'Marlorto-sof-ves': 28.38,
    'Marlorto': 41.78,
    'Marlorto-nof': 41,
    'Montisolle': 26.8,
    'Bay-sof': 22.07,
    'Bay': 47.3,
    'Misnan': 114.32,
    'Noisey-on-tön': 137.97,
    'Bôürbolns': 23.65,
    'Métiers': 28.38,
    'Méttërest': 26.02,
    'Metak-fön-sof-ves': 41.78,
    'Metak-sof-ves': 35.48,
    'Metak': 51.24,
    'Metak-est': 39.42,
    'Mahurt': 55.19,
    'Mahurt-est': 33.11,
    'Meur': 35.48,
    'Mis-ves': 67.01,
    'Mis': 27.59,
    'Mis-est': 51.24,
    'Mis-nof-est': 47.3,
    'Ruten': 63.07,
    'Industrial District': 31.54,
    'Mt. Set': 39.42,
    'Set West': 59.13,
    'Brent River': 48.88,
    'East Brent River': 67.01,
    'Set (Looped)': 98.55
  };

  // Build cumulative distances and total loop length
  let cumulative = 0;
  const stationAngles = {}; // stationId → angle in radians
  let totalKm = 0;
  stations.forEach(st => {
    totalKm += (SEGMENT_KM[st.name] || 0);
  });

  // Compute angle for each station proportional to its cumulative distance
  let runningKm = 0;
  stations.forEach(st => {
    runningKm += (SEGMENT_KM[st.name] || 0);
    // Start at top (-π/2), go clockwise
    stationAngles[st.stationId] = (2 * Math.PI * runningKm / totalKm) - Math.PI / 2;
  });

  // ── SVG dimensions ───────────────────────────────────────────────────
  const W = 2800, H = 2800;
  const CX = W / 2, CY = H / 2;
  const R = Math.min(W, H) * 0.40;

  // ── Colours & radii by station type ─────────────────────────────────
  const typeColors = {
    LTD_EXPRESS: '#e74c3c',
    EXPRESS:     '#e67e22',
    LTD_LOCAL:   '#3498db',
    LOCAL:       '#27ae60'
  };
  const typeRadius = {
    LTD_EXPRESS: 18,
    EXPRESS:     14,
    LTD_LOCAL:   11,
    LOCAL:       8
  };

  // ── Map station → screen point ───────────────────────────────────────
  const pts = stations.map(st => {
    const angle = stationAngles[st.stationId];
    return {
      x: CX + R * Math.cos(angle),
      y: CY + R * Math.sin(angle),
      angle,
      st
    };
  });

  // ── Theme colours ────────────────────────────────────────────────────
  const isHC = document.body.classList.contains('high-contrast');
  const bgColor    = isHC ? '#000' : '#f8fafc';
  const trackColor = isHC ? '#fff' : '#cbd5e1';
  const textColor  = isHC ? '#fff' : '#0f172a';
  const mutedColor = isHC ? '#aaa' : '#64748b';

  // ── Build SVG ────────────────────────────────────────────────────────
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;font-family:'Alata',sans-serif;">`;

  svg += `<rect width="${W}" height="${H}" fill="${bgColor}" rx="8"/>`;

  // Draw the ring track as a smooth polygon through the actual station points
  const polyPoints = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  svg += `<polygon points="${polyPoints}" fill="none" stroke="${trackColor}" stroke-width="5" stroke-linejoin="round"/>`;
  // Close it back to first point
  svg += `<line x1="${pts[pts.length-1].x.toFixed(1)}" y1="${pts[pts.length-1].y.toFixed(1)}" x2="${pts[0].x.toFixed(1)}" y2="${pts[0].y.toFixed(1)}" stroke="${trackColor}" stroke-width="5"/>`;

  // ── Legend ───────────────────────────────────────────────────────────
  const legend = [
    { type: 'LTD_EXPRESS', label: 'Ltd Express' },
    { type: 'EXPRESS',     label: 'Express' },
    { type: 'LTD_LOCAL',   label: 'Ltd Local' },
    { type: 'LOCAL',       label: 'Local' },
  ];
  legend.forEach((l, i) => {
    const lx = 20, ly = 20 + i * 36;
    svg += `<circle cx="${lx+10}" cy="${ly+10}" r="${typeRadius[l.type]}" fill="${typeColors[l.type]}"/>`;
    svg += `<text x="${lx+30}" y="${ly+15}" font-size="20" fill="${mutedColor}" font-weight="600">${l.label}</text>`;
  });

  // ── Title ────────────────────────────────────────────────────────────
  svg += `<text x="${CX}" y="30" text-anchor="middle" font-size="24" font-weight="bold" fill="${textColor}">Shore Connect Ring Line (to scale)</text>`;

  // ── Station nodes + labels ───────────────────────────────────────────
  pts.forEach((p, i) => {
    const { st } = p;
    const color = typeColors[st.type] || '#888';
    const r = typeRadius[st.type] || 8;

    // Push label outward; alternate inner/outer for crowded sections
    const labelDist = r + 22;
    const lx = CX + (R + labelDist) * Math.cos(p.angle);
    const ly = CY + (R + labelDist) * Math.sin(p.angle);
    const anchor = lx < CX - 10 ? 'end' : lx > CX + 10 ? 'start' : 'middle';

    svg += `<g class="map-station" style="cursor:pointer" onclick="mapStationClick('${st.stationId}')">`;
    svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r+7}" fill="${color}" opacity="0.15" class="map-hover-ring"/>`;
    svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${color}" stroke="#fff" stroke-width="2.5"/>`;
    // Station name label — full name, no truncation
    svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" font-size="16" fill="${textColor}" font-weight="500">${st.name}</text>`;
    svg += `</g>`;
  });

  svg += `</svg>`;

  resultsDiv.innerHTML = `
    <div class="route-map-container">
      <p style="margin:0 0 10px;font-size:0.85rem;color:var(--muted);">
        Stations are positioned to scale by real segment distances. Click any station to open its live departure board.
      </p>
      ${svg}
    </div>
  `;
}

function mapStationClick(stationId) {
  // Stop any running live board intervals before switching
  if (liveBoardInterval) { clearInterval(liveBoardInterval); liveBoardInterval = null; }
  if (liveBoardRebuildInterval) { clearInterval(liveBoardRebuildInterval); liveBoardRebuildInterval = null; }

  // Switch to Live Board mode
  setMode({ btn: liveBoardBtn, panel: liveBoardSearch });

  // Select the correct station in the dropdown
  const sel = document.getElementById('liveBoardStation');
  for (let i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === stationId) {
      sel.selectedIndex = i;
      break;
    }
  }

  // Start the live board
  document.getElementById('startLiveBoard').click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ================================================================
   FEATURE: STATION STATS DASHBOARD
   ================================================================ */

document.getElementById('statsSearchBtn').addEventListener('click', () => {
  if (!timetableData) return;
  const stationId = document.getElementById('statsStation').value;
  if (!stationId) return;
  renderStationStats(stationId);
});

function renderStationStats(stationId) {
  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = '<div class="loading">Calculating stats…</div>';

  setTimeout(() => {
    const station = stationLookup[stationId];
    const stops = stopsByStation[stationId] || [];

    if (!stops.length) {
      resultsDiv.innerHTML = '<p>No timetable data for this station.</p>';
      return;
    }

    // ── Hourly traffic ──────────────────────────────────────────
    const hourCounts = new Array(24).fill(0);
    stops.forEach(s => {
      const t = s.departure || s.arrival;
      if (t) hourCounts[parseInt(t.split(':')[0], 10)]++;
    });
    const maxHour = Math.max(...hourCounts);
    const peakHour = hourCounts.indexOf(maxHour);

    // ── Service-type breakdown ───────────────────────────────────
    const typeCounts = {};
    stops.forEach(s => {
      const train = timetableData.trains.find(t => t.trainId === s.trainId);
      if (!train) return;
      typeCounts[train.serviceType] = (typeCounts[train.serviceType] || 0) + 1;
    });

    // ── Direction split ──────────────────────────────────────────
    let cwCount = 0, ccwCount = 0;
    stops.forEach(s => {
      const train = timetableData.trains.find(t => t.trainId === s.trainId);
      if (!train) return;
      if (train.direction === 'CW') cwCount++;
      else ccwCount++;
    });

    // ── Unique trains ────────────────────────────────────────────
    const uniqueTrains = new Set(stops.map(s => s.trainId));

    // ── Average dwell time ───────────────────────────────────────
    const dwells = stops
      .map(s => { if (!s.arrival || !s.departure) return null; const d = toSeconds(s.departure) - toSeconds(s.arrival); return d < 0 ? null : d; })
      .filter(d => d !== null);
    const avgDwell = dwells.length ? Math.round(dwells.reduce((a,b) => a+b, 0) / dwells.length) : null;

    // ── Top 5 destinations ───────────────────────────────────────
    const destCounts = {};
    stops.forEach(s => {
      const trainStops = stopsByTrain[s.trainId];
      if (!trainStops) return;
      const last = trainStops[trainStops.length - 1];
      if (!last || last.stationId === stationId) return;
      const name = stationLookup[last.stationId]?.name || last.stationId;
      destCounts[name] = (destCounts[name] || 0) + 1;
    });
    const topDests = Object.entries(destCounts).sort((a,b) => b[1]-a[1]).slice(0, 5);
    const maxDest = topDests[0]?.[1] || 1;

    // ── Build HTML ───────────────────────────────────────────────
    const typeClassMap = {
      LTD_EXPRESS: 'chip-ltd-express',
      EXPRESS:     'chip-express',
      LTD_LOCAL:   'chip-ltd-local',
      LOCAL:       'chip-local'
    };

    // Hourly bar chart (only hours 04–23)
    let hourBars = '';
    for (let h = 4; h < 24; h++) {
      const pct = maxHour ? Math.round(hourCounts[h] / maxHour * 100) : 0;
      const isPeak = h === peakHour;
      hourBars += `
        <div class="stats-bar-row">
          <span class="stats-bar-label">${String(h).padStart(2,'0')}</span>
          <div class="stats-bar-track">
            <div class="stats-bar-fill" style="width:${pct}%;${isPeak ? 'background:#e74c3c' : ''}"></div>
          </div>
          <span class="stats-bar-count">${hourCounts[h]}</span>
        </div>`;
    }

    // Top destinations bars
    let destBars = topDests.map(([name, cnt]) => {
      const pct = Math.round(cnt / maxDest * 100);
      const shortName = name.length > 22 ? name.substring(0,20)+'…' : name;
      return `
        <div class="stats-bar-row">
          <span class="stats-bar-label" style="width:120px;text-align:left;font-size:0.78rem">${shortName}</span>
          <div class="stats-bar-track">
            <div class="stats-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="stats-bar-count">${cnt}</span>
        </div>`;
    }).join('');

    // Service type chips
    const typeChips = Object.entries(typeCounts).map(([type, cnt]) => {
      const cls = typeClassMap[type] || '';
      return `<span class="stats-type-chip ${cls}">${type.replace('_',' ')} ×${cnt}</span>`;
    }).join('');

    resultsDiv.innerHTML = `
      <div style="margin-bottom:12px">
        <strong style="font-size:1.05rem">${station.name}</strong>
        <span style="font-size:0.8rem;color:var(--muted);margin-left:8px">${station.type?.replace('_',' ') || ''} station</span>
      </div>

      <div class="stats-container">

        <div class="stats-card">
          <h4>Summary</h4>
          <div class="stats-metric-row"><span>Total services</span><span class="stats-metric-val">${stops.length}</span></div>
          <div class="stats-metric-row"><span>Unique trains</span><span class="stats-metric-val">${uniqueTrains.size}</span></div>
          <div class="stats-metric-row"><span>Clockwise</span><span class="stats-metric-val">${cwCount}</span></div>
          <div class="stats-metric-row"><span>Anti-clockwise</span><span class="stats-metric-val">${ccwCount}</span></div>
          ${avgDwell !== null ? `<div class="stats-metric-row"><span>Avg dwell time</span><span class="stats-metric-val">${avgDwell}s</span></div>` : ''}
          <div class="stats-metric-row"><span>Peak hour</span><span class="stats-metric-val">${String(peakHour).padStart(2,'0')}:00 (${maxHour} services)</span></div>
        </div>

        <div class="stats-card">
          <h4>Service types</h4>
          <div style="margin-bottom:10px">${typeChips}</div>
        </div>

        <div class="stats-card" style="grid-column: span 2">
          <h4>Hourly traffic (departures)</h4>
          ${hourBars}
        </div>

        <div class="stats-card" style="grid-column: span 2">
          <h4>Top destinations</h4>
          ${destBars || '<p style="color:var(--muted);font-size:0.85rem">No destination data available.</p>'}
        </div>

      </div>
    `;
  }, 50);
}

/* ================================================================
   FEATURE: LIVE TRAIN MAP WITH HORIZONTAL SCROLL
   ================================================================ */

// These are already declared at the top of the file
// Just assign values, don't use 'let' again
mapScrollPosition = mapScrollPosition || 0;
mapZoomLevel = mapZoomLevel || 1;

/* ================================================================
   HELPER FUNCTIONS FOR LIVE TRAIN MAP
================================================================ */

   function orderStationsOnRing(stations) {
    // The stations in the JSON are already in the correct ring line order
    // We just need to filter out duplicate physical stations (aliases)
    const ordered = [];
    const seenPhysicalStations = new Set();
    
    for (const station of stations) {
      // Get the canonical station ID (handle aliases)
      const canonicalId = stationIdAliases[station.stationId] 
        ? stationIdAliases[station.stationId][0] 
        : station.stationId;
      
      // Skip if we've already added this physical station
      if (!seenPhysicalStations.has(canonicalId)) {
        seenPhysicalStations.add(canonicalId);
        ordered.push(station);
      }
    }
    
    console.log(`Ordered ${ordered.length} unique stations around the ring line`);
    return ordered;
  }

function findStationPosition(stationId, orderedStations) {
  const idx = orderedStations.findIndex(s => s.stationId === stationId);
  if (idx === -1) return 0;
  return (idx / (orderedStations.length - 1)) * 100;
}

function getTrainSize(serviceType) {
  switch (serviceType) {
    case 'LTD_EXPRESS': return { width: 48, height: 28 };
    case 'EXPRESS': return { width: 44, height: 26 };
    case 'LTD_LOCAL': return { width: 40, height: 24 };
    default: return { width: 36, height: 22 };
  }
}

function showTrainPopup(trainId) {
  const train = timetableData.trains.find(t => t.trainId === trainId);
  const trainPos = currentTrainPositions.find(t => t.trainId === trainId);
  
  if (!train || !trainPos) return;
  
  const currentStationName = stationLookup[trainPos.currentStation.stationId]?.name || trainPos.currentStation.stationId;
  const nextStationName = stationLookup[trainPos.nextStation.stationId]?.name || trainPos.nextStation.stationId;
  const origin = stationLookup[stopsByTrain[trainId][0].stationId]?.name;
  const terminus = stationLookup[stopsByTrain[trainId][stopsByTrain[trainId].length - 1].stationId]?.name;
  
  // Calculate time until next station
  const currentSeconds = getGMT12Seconds();
  const arrivalSeconds = toSeconds(trainPos.arrivalTime);
  let secondsUntilArrival = arrivalSeconds - currentSeconds;
  if (secondsUntilArrival < -43200) secondsUntilArrival += 86400;
  
  let timeUntilText = '';
  if (secondsUntilArrival <= 0) {
    timeUntilText = 'Arriving now';
  } else if (secondsUntilArrival < 60) {
    timeUntilText = `${secondsUntilArrival} seconds`;
  } else if (secondsUntilArrival < 3600) {
    timeUntilText = `${Math.floor(secondsUntilArrival / 60)} minutes`;
  } else {
    timeUntilText = `${Math.floor(secondsUntilArrival / 3600)}h ${Math.floor((secondsUntilArrival % 3600) / 60)}m`;
  }
  
  // Create popup
  const overlay = document.createElement('div');
  overlay.className = 'popup-overlay';
  overlay.onclick = () => {
    overlay.remove();
    popup.remove();
  };
  
  const popup = document.createElement('div');
  popup.className = 'train-popup';
  popup.innerHTML = `
    <button class="popup-close" onclick="this.closest('.popup-overlay')?.remove(); this.closest('.train-popup')?.remove();">×</button>
    <h3>🚆 Train ${train.trainId}</h3>
    <div class="popup-row">
      <span class="popup-label">Service Type:</span>
      <span class="popup-value">${train.serviceType.replace('_', ' ')}</span>
    </div>
    <div class="popup-row">
      <span class="popup-label">Direction:</span>
      <span class="popup-value">${train.direction === 'CW' ? 'Clockwise ↻' : 'Anti-Clockwise ↺'}</span>
    </div>
    <div class="popup-row">
      <span class="popup-label">Origin:</span>
      <span class="popup-value">${origin || '—'}</span>
    </div>
    <div class="popup-row">
      <span class="popup-label">Terminus:</span>
      <span class="popup-value">${terminus || '—'}</span>
    </div>
    <div class="popup-row">
      <span class="popup-label">Current Station:</span>
      <span class="popup-value">${currentStationName}</span>
    </div>
    <div class="popup-row">
      <span class="popup-label">Next Station:</span>
      <span class="popup-value"><strong>${nextStationName}</strong></span>
    </div>
    <div class="popup-row">
      <span class="popup-label">Scheduled Arrival:</span>
      <span class="popup-value">${trainPos.arrivalTime}</span>
    </div>
    <div class="popup-row">
      <span class="popup-label">Time until arrival:</span>
      <span class="popup-value" style="color: #ffd700;">${timeUntilText}</span>
    </div>
    <div style="margin-top: 16px; text-align: center;">
      <button class="search-btn" onclick="showFullTimetable(['${train.trainId}'], '${trainPos.currentStation.stationId}', '${trainPos.nextStation.stationId}'); document.querySelector('.popup-overlay')?.remove(); document.querySelector('.train-popup')?.remove();">
        View Full Schedule
      </button>
    </div>
  `;
  
  document.body.appendChild(overlay);
  document.body.appendChild(popup);
}

function renderLiveTrainMap() {
  if (!timetableData) return;
  
  const resultsDiv = document.getElementById('results');
  const container = document.getElementById('trainMapContainer');
  
  // Save current scroll position before rerender
  if (container) {
    mapScrollPosition = container.scrollLeft;
  }
  
  resultsDiv.innerHTML = '<div class="loading">Loading train positions...</div>';
  
  setTimeout(() => {
    const stations = timetableData.stations;
    const currentSeconds = getGMT12Seconds();
    
    const orderedStations = orderStationsOnRing(stations);
    const stationCount = orderedStations.length;
    
    const positions = [];
    orderedStations.forEach((station, idx) => {
      positions.push({
        station: station,
        position: (idx / (stationCount - 1)) * 100,
        idx: idx
      });
    });
    
    // Find all active trains
    const activeTrains = [];
    const allTrains = timetableData.trains;
    
    allTrains.forEach(train => {
      const trainStops = stopsByTrain[train.trainId];
      if (!trainStops || trainStops.length === 0) return;
      
      let currentStop = null;
      let nextStop = null;
      
      for (let i = 0; i < trainStops.length - 1; i++) {
        const stop = trainStops[i];
        const next = trainStops[i + 1];
        const depTime = toSeconds(stop.departure || stop.arrival);
        const arrTime = toSeconds(next.arrival || next.departure);
        
        let depSeconds = depTime;
        let arrSeconds = arrTime;
        
        if (arrSeconds < depSeconds) arrSeconds += 86400;
        
        if (currentSeconds >= depSeconds - 300 && currentSeconds <= arrSeconds + 300) {
          currentStop = stop;
          nextStop = next;
          break;
        }
      }
      
      if (currentStop && nextStop) {
        const fromPos = findStationPosition(currentStop.stationId, orderedStations);
        const toPos = findStationPosition(nextStop.stationId, orderedStations);
        
        let progress = 0;
        const depTime = toSeconds(currentStop.departure || currentStop.arrival);
        const arrTime = toSeconds(nextStop.arrival || nextStop.departure);
        let totalDuration = arrTime - depTime;
        if (totalDuration < 0) totalDuration += 86400;
        
        let elapsed = currentSeconds - depTime;
        if (elapsed < 0) elapsed += 86400;
        
        if (totalDuration > 0) {
          progress = Math.min(0.95, Math.max(0.05, elapsed / totalDuration));
        }
        
        let position;
        if (train.direction === 'CW') {
          position = fromPos + ((toPos - fromPos) * progress);
        } else {
          position = fromPos - ((fromPos - toPos) * progress);
        }
        
        position = Math.max(0, Math.min(100, position));
        
        activeTrains.push({
          trainId: train.trainId,
          serviceType: train.serviceType,
          direction: train.direction,
          position: position,
          currentStation: currentStop,
          nextStation: nextStop,
          arrivalTime: nextStop.arrival || '—',
          departureTime: currentStop.departure || '—'
        });
      }
    });
    
    currentTrainPositions = activeTrains;
    
    const nowString = getGMT12Time().toISOString().replace('T', ' ').substring(0, 19);
    const syncStatus = atomicTimeSynced ? '⚛ Atomic Time' : '⏳ Local Time';
    
    // Calculate zoomed width (this is the only thing that scales)
    const baseWidth = Math.max(1500, stationCount * 80);
    const zoomedWidth = baseWidth * mapZoomLevel;
    
    let html = `
      <div class="live-board-container">
        <div class="live-board-header">
          <div class="live-board-title">
            <h2>🚆 Shore Connect - Live Train Map</h2>
            <div class="live-clock-large">${nowString} GMT+12</div>
          </div>
          <div class="live-board-status">
            <span class="live-dot"></span> ${syncStatus} • ${activeTrains.length} active trains
          </div>
        </div>
        
        <!-- Zoom Controls -->
        <div class="map-zoom-controls" style="display: flex; gap: 10px; margin-bottom: 15px; align-items: center;">
          <button id="zoomOutBtn" class="search-btn" style="padding: 5px 12px;">🔍 Zoom Out</button>
          <button id="zoomInBtn" class="search-btn" style="padding: 5px 12px;">🔍 Zoom In</button>
          <button id="resetZoomBtn" class="search-btn" style="padding: 5px 12px;">⟲ Reset View</button>
          <span style="font-size: 12px; color: var(--muted);">Zoom: ${Math.round(mapZoomLevel * 100)}%</span>
          <span style="font-size: 12px; color: var(--muted); margin-left: auto;">← Scroll horizontally →</span>
        </div>
        
        <div class="map-legend">
          <div class="map-legend-item"><div class="map-legend-dot ltd-express"></div><span>Ltd Express</span></div>
          <div class="map-legend-item"><div class="map-legend-dot express"></div><span>Express</span></div>
          <div class="map-legend-item"><div class="map-legend-dot ltd-local"></div><span>Ltd Local</span></div>
          <div class="map-legend-item"><div class="map-legend-dot local"></div><span>Local</span></div>
          <div class="map-legend-item"><div class="map-legend-train-cw"></div><span>Clockwise (CW)</span></div>
          <div class="map-legend-item"><div class="map-legend-train-ccw"></div><span>Anti-Clockwise (CCW)</span></div>
        </div>
        
        <div class="train-map-container" id="trainMapContainer" style="overflow-x: auto; overflow-y: hidden; cursor: grab;">
          <div class="train-map-scroll" style="min-width: ${zoomedWidth}px; width: ${zoomedWidth}px; transition: width 0.2s ease;">
            <div class="ring-line-track" style="position: relative; height: 200px;">
    `;
    
    // Add station markers with FIXED sizes (no zoom scaling)
    positions.forEach((pos) => {
      const station = pos.station;
      const typeClass = station.type.toLowerCase();
      
      html += `
        <div class="station-marker ${typeClass}" style="left: ${pos.position}%; top: 50%; cursor: pointer;" data-station-id="${station.stationId}">
          <div class="station-dot" style="width: 12px; height: 12px; top: -6px;"></div>
          <div class="station-label" style="top: 20px; font-size: 11px;">${station.name}</div>
        </div>
      `;
    });
    
    // Add train icons with FIXED size (no zoom scaling)
    activeTrains.forEach(train => {
      const typeSize = getTrainSize(train.serviceType);
      const fixedWidth = typeSize.width;
      const fixedHeight = typeSize.height;
      const directionClass = train.direction === 'CW' ? 'cw' : 'ccw';
      
      html += `
        <div class="train-icon ${directionClass}" 
             style="left: ${train.position}%; top: 50%; transform: translateX(-50%) translateY(-50%); cursor: pointer;"
             data-train-id="${train.trainId}"
             onclick="showTrainPopup('${train.trainId}')">
          <svg width="${fixedWidth}" height="${fixedHeight}" viewBox="0 0 40 24" style="display: block;">
            <rect x="2" y="2" width="36" height="20" rx="4" fill="${train.direction === 'CW' ? '#3498db' : '#e74c3c'}" stroke="#fff" stroke-width="1.5"/>
            <circle cx="10" cy="18" r="4" fill="#2c3e50" stroke="#fff" stroke-width="1"/>
            <circle cx="30" cy="18" r="4" fill="#2c3e50" stroke="#fff" stroke-width="1"/>
            <rect x="8" y="6" width="24" height="6" rx="2" fill="#ffd700" opacity="0.8"/>
            <text x="20" y="12" text-anchor="middle" font-size="8" fill="#1a1a2e" font-weight="bold">${train.trainId}</text>
          </svg>
          <div class="train-tooltip" style="display: none;">
            ${train.trainId} • ${train.serviceType.replace('_', ' ')}<br>
            → ${stationLookup[train.nextStation.stationId]?.name || train.nextStation.stationId}
          </div>
        </div>
      `;
    });
    
    html += `
            </div>
          </div>
        </div>
        
        <div class="live-board-footer">
          <small>Click any train for details • Trains shown at approximate positions • Updates every 5 seconds • Scroll to pan • Zoom to see more stations</small>
        </div>
      </div>
    `;
    
    resultsDiv.innerHTML = html;
    
    // Restore scroll position after render
    const newContainer = document.getElementById('trainMapContainer');
    if (newContainer) {
      newContainer.scrollLeft = mapScrollPosition;
      
      // Add drag to scroll functionality
      let isDragging = false;
      let startX;
      let scrollLeft;
      
      newContainer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.pageX - newContainer.offsetLeft;
        scrollLeft = newContainer.scrollLeft;
        newContainer.style.cursor = 'grabbing';
      });
      
      newContainer.addEventListener('mouseleave', () => {
        isDragging = false;
        newContainer.style.cursor = 'grab';
      });
      
      newContainer.addEventListener('mouseup', () => {
        isDragging = false;
        newContainer.style.cursor = 'grab';
      });
      
      newContainer.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const x = e.pageX - newContainer.offsetLeft;
        const walk = (x - startX) * 2;
        newContainer.scrollLeft = scrollLeft - walk;
      });
      
      // Wheel zoom support (Ctrl/Cmd + scroll)
      newContainer.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.deltaY < 0) {
            zoomIn();
          } else {
            zoomOut();
          }
        }
      });
    }
    
    // Add tooltip hover effects
    document.querySelectorAll('.train-icon').forEach(icon => {
      icon.addEventListener('mouseenter', () => {
        const tooltip = icon.querySelector('.train-tooltip');
        if (tooltip) tooltip.style.display = 'block';
      });
      icon.addEventListener('mouseleave', () => {
        const tooltip = icon.querySelector('.train-tooltip');
        if (tooltip) tooltip.style.display = 'none';
      });
    });
    
    // Add station click to open live board
    document.querySelectorAll('.station-marker').forEach(marker => {
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        const stationId = marker.dataset.stationId;
        if (stationId) {
          stopLiveMap(); // Stop auto-refresh when leaving
          setMode({ btn: liveBoardBtn, panel: liveBoardSearch });
          const sel = document.getElementById('liveBoardStation');
          for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === stationId) {
              sel.selectedIndex = i;
              break;
            }
          }
          document.getElementById('startLiveBoard').click();
        }
      });
    });
    
    // Add zoom button handlers
    document.getElementById('zoomInBtn')?.addEventListener('click', () => zoomIn());
    document.getElementById('zoomOutBtn')?.addEventListener('click', () => zoomOut());
    document.getElementById('resetZoomBtn')?.addEventListener('click', () => resetZoom());
    
  }, 50);
}

// Zoom functions
function zoomIn() {
  if (mapZoomLevel < 2.5) {
    mapZoomLevel += 0.25;
    renderLiveTrainMap();
  }
}

function zoomOut() {
  if (mapZoomLevel > 0.5) {
    mapZoomLevel -= 0.25;
    renderLiveTrainMap();
  }
}

function resetZoom() {
  mapZoomLevel = 1;
  mapScrollPosition = 0;
  renderLiveTrainMap();
}

// Update startLiveMap to reset scroll position when first opening
function startLiveMap() {
  if (!timetableData) return;
  
  if (mapRefreshInterval) {
    clearInterval(mapRefreshInterval);
  }
  
  // Reset scroll and zoom when opening map
  mapScrollPosition = 0;
  mapZoomLevel = 1;
  
  renderLiveTrainMap();
  mapRefreshInterval = setInterval(() => {
    renderLiveTrainMap();
  }, 5000);
}

// Set up refresh button handler
const refreshMapBtn = document.getElementById('refreshMapBtn');
if (refreshMapBtn) {
  refreshMapBtn.addEventListener('click', () => {
    if (timetableData) {
      renderLiveTrainMap();
    }
  });
}

/* ================================================================
   ADMIN SYSTEM - COMPLETE WITH ALL FEATURES
   ================================================================ */

// Admin state
let currentAdminUser = null;
const ADMIN_CREDENTIALS = {
  'admin': { password: 'shore123', name: 'Senior Controller' },
  'controller1': { password: 'rail456', name: 'Duty Controller' },
  'platform_mgr': { password: 'plat789', name: 'Platform Manager' }
};

// Verify password
function verifyPassword(staffId, password) {
  if (!ADMIN_CREDENTIALS[staffId]) return false;
  return ADMIN_CREDENTIALS[staffId].password === password;
}

// Initialize admin system
function initAdminSystem() {
  // Check if already authenticated from previous session
  if (sessionStorage.getItem('admin_authenticated') === 'true') {
    currentAdminUser = sessionStorage.getItem('admin_user');
    showAdminInterface();
  }
  
  // Set up event listeners for core admin functions
  document.getElementById('adminLoginBtn').addEventListener('click', adminLogin);
  document.getElementById('adminCancelBtn').addEventListener('click', hideAdminLogin);
  document.getElementById('adminLogoutBtn').addEventListener('click', adminLogout);
  document.getElementById('adminToggleBtn').addEventListener('click', toggleAdminPanel);
  
  // Delay management
  document.getElementById('logDelayBtn').addEventListener('click', logTrainDelay);
  
  // Platform override
  document.getElementById('overridePlatformBtn').addEventListener('click', overridePlatform);
  
  // Service status
  document.getElementById('updateServiceStatusBtn').addEventListener('click', updateServiceStatus);
  document.getElementById('serviceStatus').addEventListener('change', (e) => {
    document.getElementById('terminationStationRow').style.display = 
      e.target.value === 'SHORT_TERMINATED' ? 'block' : 'none';
  });
  
  // Staff notes
  document.getElementById('addNoteBtn').addEventListener('click', addStaffNote);
  document.getElementById('noteType').addEventListener('change', updateNoteTargets);
  
  // Admin tabs with live update management
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', switchAdminTab);
  });
  
  // Add a visible login button to the header
  addAdminLoginButton();
  
  // Keyboard shortcut to open admin (Ctrl+Shift+A)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      if (!currentAdminUser) {
        showAdminLogin();
      } else {
        toggleAdminPanel();
      }
    }
  });
  
  // Populate admin dropdowns when data loads
  populateAdminDropdowns();
  
  // Make sure modal and panel are hidden on init
  document.getElementById('adminAuthModal').classList.add('hidden');
  document.getElementById('adminPanel').classList.add('hidden');
  
  // Initialize dashboard with live updates when switching to dashboard tab
  document.querySelector('[data-tab="dashboardPanel"]').addEventListener('click', () => {
    startDashboardLive();
  });
  
  // Stop dashboard updates when leaving dashboard tab
  document.querySelectorAll('[data-tab]').forEach(tab => {
    if (tab.dataset.tab !== 'dashboardPanel') {
      tab.addEventListener('click', () => {
        stopDashboardLive();
      });
    }
  });
}

// Updated admin logout to clean up all intervals
function adminLogout() {
  currentAdminUser = null;
  sessionStorage.removeItem('admin_authenticated');
  sessionStorage.removeItem('admin_user');
  hideAdminInterface();
  document.getElementById('adminPanel').classList.add('hidden');
  
  // Stop all live updates
  stopDashboardLive();
  stopStationMonitor();
  
  logAdminAction('LOGOUT', 'Staff member logged out');
}

// Updated showAdminInterface to start dashboard if on dashboard tab
function showAdminInterface() {
  document.getElementById('adminUserName').textContent = currentAdminUser;
  document.getElementById('adminToggleBtn').classList.remove('hidden');
  document.getElementById('adminPanel').classList.remove('hidden');
  populateAdminDropdowns();
  refreshAdminDisplays();
  
  // Start dashboard live updates if dashboard tab is active
  const dashboardTab = document.querySelector('[data-tab="dashboardPanel"]');
  if (dashboardTab && dashboardTab.classList.contains('active')) {
    startDashboardLive();
  }
}

// Updated toggleAdminPanel to manage dashboard updates
function toggleAdminPanel() {
  const panel = document.getElementById('adminPanel');
  panel.classList.toggle('hidden');
  
  if (!panel.classList.contains('hidden')) {
    // Panel is now visible
    const dashboardTab = document.querySelector('[data-tab="dashboardPanel"]');
    if (dashboardTab && dashboardTab.classList.contains('active')) {
      startDashboardLive();
    }
  } else {
    // Panel is now hidden
    stopDashboardLive();
    stopStationMonitor();
  }
}

// Updated switchAdminTab to manage live updates
function switchAdminTab(e) {
  // Stop station monitor if leaving that tab
  if (e.target.dataset.tab !== 'stationMonitorPanel') {
    stopStationMonitor();
  }
  
  // Stop dashboard updates if leaving dashboard tab
  if (e.target.dataset.tab !== 'dashboardPanel') {
    stopDashboardLive();
  }
  
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
  
  e.target.classList.add('active');
  const tabId = e.target.dataset.tab;
  document.getElementById(tabId).classList.remove('hidden');
  
  // Start live updates for specific tabs
  if (tabId === 'dashboardPanel') {
    startDashboardLive();
  } else if (tabId === 'stationMonitorPanel') {
    populateStationMonitorDropdown();
    // Don't auto-start monitor - wait for user to click Monitor button
  } else if (tabId === 'batchPanel') {
    populateBatchStationDropdown();
  }
}

// Updated refreshAdminDisplays to not conflict with live dashboard
function refreshAdminDisplays() {
  if (currentAdminUser && !document.getElementById('adminPanel').classList.contains('hidden')) {
    refreshActiveDelays();
    refreshActiveOverrides();
    refreshActiveServiceChanges();
    refreshActiveNotes();
    // Don't call updateDashboard() here - the live interval handles it
  }
}

// Add a visible login button to the topbar
function addAdminLoginButton() {
  const topbarInner = document.querySelector('.topbar-inner');
  if (topbarInner) {
    const loginBtn = document.createElement('button');
    loginBtn.id = 'adminLoginBtn_visible';
    loginBtn.textContent = '🔐 Staff Login';
    loginBtn.style.cssText = `
      background: rgba(255,255,255,0.1);
      color: #a0b0c0;
      border: 1px solid rgba(255,255,255,0.2);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
      margin-left: 10px;
      transition: all 0.2s;
    `;
    loginBtn.addEventListener('mouseenter', () => {
      loginBtn.style.background = 'rgba(255,255,255,0.2)';
      loginBtn.style.color = '#fff';
    });
    loginBtn.addEventListener('mouseleave', () => {
      loginBtn.style.background = 'rgba(255,255,255,0.1)';
      loginBtn.style.color = '#a0b0c0';
    });
    loginBtn.addEventListener('click', () => {
      if (currentAdminUser) {
        toggleAdminPanel();
      } else {
        showAdminLogin();
      }
    });
    topbarInner.appendChild(loginBtn);
  }
}

// Show/hide admin login modal
function showAdminLogin() {
  const modal = document.getElementById('adminAuthModal');
  if (modal) {
    modal.classList.remove('hidden');
    document.getElementById('adminLoginError').style.display = 'none';
    document.getElementById('adminStaffId').value = '';
    document.getElementById('adminPassword').value = '';
  }
}

function hideAdminLogin() {
  const modal = document.getElementById('adminAuthModal');
  if (modal) {
    modal.classList.add('hidden');
    document.getElementById('adminStaffId').value = '';
    document.getElementById('adminPassword').value = '';
    document.getElementById('adminLoginError').style.display = 'none';
  }
}

// Admin authentication
function adminLogin() {
  const staffId = document.getElementById('adminStaffId').value.trim();
  const password = document.getElementById('adminPassword').value;
  
  if (!staffId || !password) {
    showLoginError('Please enter both Staff ID and Password');
    return;
  }
  
  if (verifyPassword(staffId, password)) {
    currentAdminUser = ADMIN_CREDENTIALS[staffId].name;
    sessionStorage.setItem('admin_authenticated', 'true');
    sessionStorage.setItem('admin_user', currentAdminUser);
    hideAdminLogin();
    showAdminInterface();
    logAdminAction('LOGIN', 'Staff member logged in');
  } else {
    showLoginError('Invalid credentials');
  }
}

function showLoginError(message) {
  const errorEl = document.getElementById('adminLoginError');
  errorEl.textContent = message;
  errorEl.style.display = 'block';
}



// Switch to a tab by name (for quick actions)
function switchAdminTabByName(tabName) {
  const tab = document.querySelector(`[data-tab="${tabName}"]`);
  if (tab) {
    tab.click();
  }
}

// Admin action logging
function logAdminAction(action, details) {
  if (!window.adminLog) window.adminLog = [];
  window.adminLog.push({
    action: action,
    details: details,
    user: currentAdminUser,
    timestamp: new Date().toISOString()
  });
  console.log(`[ADMIN] ${currentAdminUser} - ${action}: ${details}`);
}

/* ================================================================
   FEATURE 1: DELAY MANAGEMENT (Supabase Version)
   ================================================================ */

async function logTrainDelay() {
  const trainId = document.getElementById('delayTrainId').value.trim();
  const minutes = parseInt(document.getElementById('delayMinutes').value);
  const reason = document.getElementById('delayReason').value;
  
  if (!trainId || !minutes) {
    alert('Please enter Train ID and delay minutes');
    return;
  }
  
  const train = timetableData.trains.find(t => t.trainId === trainId);
  if (!train) {
    alert('Train not found');
    return;
  }
  
  const delayKey = `${trainId}_${Date.now()}`;
  
  try {
    const { error } = await supabase
      .from('train_delays')
      .insert([{
        id: delayKey,
        train_id: trainId,
        minutes: minutes,
        reason: reason,
        logged_by: currentAdminUser,
        timestamp: new Date().toISOString(),
        active: true
      }]);
    
    if (error) throw error;
    
    logAdminAction('DELAY_LOG', `Train ${trainId} delayed ${minutes}min - ${reason}`);
    await refreshActiveDelays();
    
    document.getElementById('delayTrainId').value = '';
    document.getElementById('delayMinutes').value = '5';
    
    showTemporaryMessage(`Delay logged for train ${trainId}`, 'success');
  } catch (error) {
    console.error('Log delay error:', error);
    alert('Failed to log delay: ' + error.message);
  }
}

async function removeDelay(delayKey) {
  try {
    const { error } = await supabase
      .from('train_delays')
      .update({ active: false })
      .eq('id', delayKey);
    
    if (error) throw error;
    
    await refreshActiveDelays();
    showTemporaryMessage('Delay removed', 'success');
  } catch (error) {
    console.error('Remove delay error:', error);
    alert('Failed to remove delay: ' + error.message);
  }
}

async function refreshActiveDelays() {
  const listEl = document.getElementById('activeDelaysList');
  if (!listEl) return;
  
  try {
    const { data: activeDelays, error } = await supabase
      .from('train_delays')
      .select('*')
      .eq('active', true)
      .order('timestamp', { ascending: false });
    
    if (error) throw error;
    
    if (!activeDelays || activeDelays.length === 0) {
      listEl.innerHTML = '<p style="color: #64748b;">No active delays</p>';
      return;
    }
    
    listEl.innerHTML = activeDelays.map(delay => `
      <div class="delay-item">
        <div class="item-info">
          <strong>${delay.train_id}</strong> - ${delay.minutes}min delay<br>
          <span style="color: #a0a0b0;">${delay.reason.replace(/_/g, ' ')}</span>
          <div class="item-timestamp">Logged by ${delay.logged_by} at ${new Date(delay.timestamp).toLocaleTimeString()}</div>
        </div>
        <button class="item-action" onclick="removeDelay('${delay.id}')">Clear</button>
      </div>
    `).join('');
  } catch (error) {
    console.error('Refresh delays error:', error);
  }
}

/* ================================================================
   FEATURE 2: PLATFORM OVERRIDE (Supabase Version)
   ================================================================ */

async function overridePlatform() {
  const trainId = document.getElementById('platformTrainId').value.trim();
  const stationId = document.getElementById('platformStation').value;
  const newPlatform = parseInt(document.getElementById('newPlatform').value);
  const reason = document.getElementById('platformReason').value;
  
  if (!trainId || !stationId || !newPlatform) {
    alert('Please fill all fields');
    return;
  }
  
  const key = `${trainId}_${stationId}_${Date.now()}`;
  
  try {
    const { error } = await supabase
      .from('platform_overrides')
      .insert([{
        id: key,
        train_id: trainId,
        station_id: stationId,
        platform: newPlatform,
        reason: reason,
        set_by: currentAdminUser,
        timestamp: new Date().toISOString(),
        active: true
      }]);
    
    if (error) throw error;
    
    logAdminAction('PLATFORM_OVERRIDE', `Train ${trainId} at ${stationId} → Platform ${newPlatform} (${reason})`);
    await refreshActiveOverrides();
    
    document.getElementById('platformTrainId').value = '';
    document.getElementById('newPlatform').value = '';
    
    showTemporaryMessage(`Platform override set for train ${trainId}`, 'success');
  } catch (error) {
    console.error('Platform override error:', error);
    alert('Failed to set platform override: ' + error.message);
  }
}

async function removePlatformOverride(key) {
  try {
    const { error } = await supabase
      .from('platform_overrides')
      .update({ active: false })
      .eq('id', key);
    
    if (error) throw error;
    
    await refreshActiveOverrides();
    showTemporaryMessage('Platform override removed', 'success');
  } catch (error) {
    console.error('Remove override error:', error);
    alert('Failed to remove override: ' + error.message);
  }
}

async function refreshActiveOverrides() {
  const listEl = document.getElementById('activeOverridesList');
  if (!listEl) return;
  
  try {
    const { data: activeOverrides, error } = await supabase
      .from('platform_overrides')
      .select('*')
      .eq('active', true)
      .order('timestamp', { ascending: false });
    
    if (error) throw error;
    
    if (!activeOverrides || activeOverrides.length === 0) {
      listEl.innerHTML = '<p style="color: #64748b;">No active platform overrides</p>';
      return;
    }
    
    listEl.innerHTML = activeOverrides.map(override => {
      const stationName = stationLookup[override.station_id]?.name || override.station_id;
      return `
        <div class="override-item">
          <div class="item-info">
            <strong>${override.train_id}</strong> at <strong>${stationName}</strong> → P${override.platform}<br>
            <span style="color: #a0a0b0;">${override.reason.replace(/_/g, ' ')}</span>
            <div class="item-timestamp">Set by ${override.set_by} at ${new Date(override.timestamp).toLocaleTimeString()}</div>
          </div>
          <button class="item-action" onclick="removePlatformOverride('${override.id}')">Remove</button>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Refresh overrides error:', error);
  }
}

/* ================================================================
   FEATURE 3: SERVICE STATUS MANAGEMENT (Supabase Version)
   ================================================================ */

async function updateServiceStatus() {
  const trainId = document.getElementById('serviceTrainId').value.trim();
  const status = document.getElementById('serviceStatus').value;
  let terminationStation = null;
  
  if (status === 'SHORT_TERMINATED') {
    terminationStation = document.getElementById('terminationStation').value;
    if (!terminationStation) {
      alert('Please select termination station');
      return;
    }
  }
  
  if (!trainId) {
    alert('Please enter Train ID');
    return;
  }
  
  const train = timetableData.trains.find(t => t.trainId === trainId);
  if (!train) {
    alert('Train not found');
    return;
  }
  
  try {
    const { error } = await supabase
      .from('service_statuses')
      .upsert([{
        train_id: trainId,
        status: status,
        termination_station: terminationStation,
        set_by: currentAdminUser,
        timestamp: new Date().toISOString(),
        active: status !== 'NORMAL'
      }], { onConflict: 'train_id' });
    
    if (error) throw error;
    
    logAdminAction('SERVICE_STATUS', `Train ${trainId} set to ${status}${terminationStation ? ' at ' + terminationStation : ''}`);
    await refreshActiveServiceChanges();
    
    document.getElementById('serviceTrainId').value = '';
    showTemporaryMessage(`Service status updated for train ${trainId}`, 'success');
  } catch (error) {
    console.error('Service status error:', error);
    alert('Failed to update service status: ' + error.message);
  }
}

async function clearServiceStatus(trainId) {
  try {
    const { error } = await supabase
      .from('service_statuses')
      .update({ active: false, status: 'NORMAL' })
      .eq('train_id', trainId);
    
    if (error) throw error;
    
    await refreshActiveServiceChanges();
    showTemporaryMessage(`Service status cleared for train ${trainId}`, 'success');
  } catch (error) {
    console.error('Clear service status error:', error);
    alert('Failed to clear service status: ' + error.message);
  }
}

async function refreshActiveServiceChanges() {
  const listEl = document.getElementById('activeServiceChangesList');
  if (!listEl) return;
  
  try {
    const { data: activeChanges, error } = await supabase
      .from('service_statuses')
      .select('*')
      .eq('active', true)
      .order('timestamp', { ascending: false });
    
    if (error) throw error;
    
    if (!activeChanges || activeChanges.length === 0) {
      listEl.innerHTML = '<p style="color: #64748b;">No active service changes</p>';
      return;
    }
    
    const statusColors = {
      'CANCELLED': '#e74c3c',
      'SHORT_TERMINATED': '#e67e22',
      'EXPRESS_RUNNING': '#3498db',
      'DELAYED': '#f39c12'
    };
    
    listEl.innerHTML = activeChanges.map(change => {
      const color = statusColors[change.status] || '#95a5a6';
      return `
        <div class="service-change-item">
          <div class="item-info">
            <strong>${change.train_id}</strong> - 
            <span style="color: ${color}; font-weight: bold;">${change.status.replace(/_/g, ' ')}</span>
            ${change.termination_station ? `<br>Terminates at: ${stationLookup[change.termination_station]?.name || change.termination_station}` : ''}
            <div class="item-timestamp">Set by ${change.set_by} at ${new Date(change.timestamp).toLocaleTimeString()}</div>
          </div>
          <button class="item-action" onclick="clearServiceStatus('${change.train_id}')">Clear</button>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Refresh service changes error:', error);
  }
}

/* ================================================================
   FEATURE 4: STAFF NOTES (Supabase Version)
   ================================================================ */

async function addStaffNote() {
  const noteType = document.getElementById('noteType').value;
  const targetId = document.getElementById('noteTarget').value;
  const content = document.getElementById('noteContent').value.trim();
  
  if (!targetId || !content) {
    alert('Please select target and enter note content');
    return;
  }
  
  const noteId = `${noteType}_${targetId}_${Date.now()}`;
  
  try {
    const { error } = await supabase
      .from('staff_notes')
      .insert([{
        id: noteId,
        note_type: noteType,
        target_id: targetId,
        content: content,
        author: currentAdminUser,
        timestamp: new Date().toISOString()
      }]);
    
    if (error) throw error;
    
    logAdminAction('NOTE_ADDED', `${noteType} note for ${targetId}`);
    await refreshActiveNotes();
    
    document.getElementById('noteContent').value = '';
    showTemporaryMessage('Note added successfully', 'success');
  } catch (error) {
    console.error('Add note error:', error);
    alert('Failed to add note: ' + error.message);
  }
}

async function deleteStaffNote(noteType, targetId, index, noteId) {
  try {
    const { error } = await supabase
      .from('staff_notes')
      .delete()
      .eq('id', noteId);
    
    if (error) throw error;
    
    logAdminAction('NOTE_DELETED', `Deleted ${noteType} note for ${targetId}`);
    await refreshActiveNotes();
    showTemporaryMessage('Note deleted', 'success');
  } catch (error) {
    console.error('Delete note error:', error);
    alert('Failed to delete note: ' + error.message);
  }
}

function updateNoteTargets() {
  const noteType = document.getElementById('noteType').value;
  const targetSelect = document.getElementById('noteTarget');
  const labelEl = document.getElementById('noteTargetLabel');
  
  if (!targetSelect || !labelEl) return;
  
  targetSelect.innerHTML = '';
  
  if (noteType === 'station') {
    labelEl.textContent = 'Station';
    const sortedStations = [...timetableData.stations].sort((a, b) => 
      a.name.localeCompare(b.name)
    );
    sortedStations.forEach(station => {
      targetSelect.add(new Option(station.name, station.stationId));
    });
  } else {
    labelEl.textContent = 'Train';
    const sortedTrains = [...timetableData.trains].sort((a, b) => {
      const numA = parseInt(a.trainId.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.trainId.replace(/\D/g, '')) || 0;
      return numA - numB;
    });
    sortedTrains.forEach(train => {
      targetSelect.add(new Option(train.trainId, train.trainId));
    });
  }
}

async function refreshActiveNotes() {
  const listEl = document.getElementById('activeNotesList');
  if (!listEl) return;
  
  try {
    const { data: notes, error } = await supabase
      .from('staff_notes')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(20);
    
    if (error) throw error;
    
    if (!notes || notes.length === 0) {
      listEl.innerHTML = '<p style="color: #64748b;">No staff notes</p>';
      return;
    }
    
    listEl.innerHTML = notes.map(note => {
      const targetName = note.note_type === 'station' 
        ? (stationLookup[note.target_id]?.name || note.target_id)
        : note.target_id;
      
      return `
        <div class="note-item">
          <div class="item-info">
            <strong>${note.note_type === 'station' ? '🏢' : '🚆'} ${targetName}</strong><br>
            <span style="color: #e2e8f0;">${escapeHtml(note.content)}</span>
            <div class="item-timestamp">By ${note.author} at ${new Date(note.timestamp).toLocaleString()}</div>
          </div>
          <button class="item-action" onclick="deleteStaffNote('${note.note_type}', '${note.target_id}', null, '${note.id}')">×</button>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Refresh notes error:', error);
  }
}

/* ================================================================
   FEATURE 8: BATCH OPERATIONS (Updated for Supabase)
   ================================================================ */

function populateBatchStationDropdown() {
  const batchStationSelect = document.getElementById('batchStation');
  if (!batchStationSelect || batchStationSelect.options.length > 0) return;
  
  batchStationSelect.innerHTML = '';
  timetableData.stations.forEach(station => {
    batchStationSelect.add(new Option(station.name, station.stationId));
  });
}

async function batchDelayTrains() {
  const stationId = document.getElementById('batchStation').value;
  const delayMinutes = parseInt(document.getElementById('batchDelay').value);
  const reason = document.getElementById('batchReason').value;
  
  if (!stationId || !delayMinutes) {
    alert('Please select station and delay amount');
    return;
  }
  
  const affectedStops = stopsByStation[stationId] || [];
  const affectedTrains = new Set(affectedStops.map(s => s.trainId));
  
  let count = 0;
  
  for (const trainId of affectedTrains) {
    const trainStops = stopsByTrain[trainId];
    const now = getGMT12Seconds();
    const stationStop = trainStops.find(s => s.stationId === stationId);
    if (stationStop && toSeconds(stationStop.departure || stationStop.arrival) > now) {
      const delayKey = `${trainId}_batch_${Date.now()}_${count}`;
      
      try {
        const { error } = await supabase
          .from('train_delays')
          .insert([{
            id: delayKey,
            train_id: trainId,
            minutes: delayMinutes,
            reason: reason,
            logged_by: currentAdminUser,
            timestamp: new Date().toISOString(),
            active: true
          }]);
        
        if (error) throw error;
        count++;
      } catch (error) {
        console.error('Batch delay error for train', trainId, error);
      }
    }
  }
  
  logAdminAction('BATCH_DELAY', `Applied ${delayMinutes}min delay to ${count} trains at ${stationLookup[stationId]?.name}`);
  alert(`Delayed ${count} trains passing through ${stationLookup[stationId]?.name}`);
  await refreshActiveDelays();
}

/* ================================================================
   FEATURE 5: ADMIN DASHBOARD (Updated for Supabase)
   ================================================================ */

let dashboardInterval = null;
let cachedWeather = null;
let lastWeatherUpdate = 0;

async function updateDashboard() {
  const dashboardContent = document.getElementById('dashboardContent');
  if (!dashboardContent) return;
  
  const now = new Date();
  const currentSeconds = getGMT12Seconds();
  
  // Get real-time train positions (recalculate if empty)
  let activeTrainsList = currentTrainPositions;
  if (activeTrainsList.length === 0 && timetableData) {
    activeTrainsList = calculateActiveTrains();
  }
  
  const activeTrains = activeTrainsList.length;
  
  // Get counts from Supabase
  let delayedTrains = 0;
  let cancelledServices = 0;
  let shortTerminated = 0;
  let expressRunning = 0;
  let activeOverrides = 0;
  let recentNotes = [];
  
  try {
    // Get delays from Supabase
    const { data: delays } = await supabase
      .from('train_delays')
      .select('*')
      .eq('active', true);
    delayedTrains = delays?.length || 0;
    
    // Get service statuses from Supabase
    const { data: services } = await supabase
      .from('service_statuses')
      .select('*')
      .eq('active', true);
    cancelledServices = services?.filter(s => s.status === 'CANCELLED').length || 0;
    shortTerminated = services?.filter(s => s.status === 'SHORT_TERMINATED').length || 0;
    expressRunning = services?.filter(s => s.status === 'EXPRESS_RUNNING').length || 0;
    
    // Get platform overrides from Supabase
    const { data: overrides } = await supabase
      .from('platform_overrides')
      .select('*')
      .eq('active', true);
    activeOverrides = overrides?.length || 0;
    
    // Get recent notes from Supabase
    const { data: notes } = await supabase
      .from('staff_notes')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(5);
    recentNotes = notes || [];
    
  } catch (error) {
    console.error('Dashboard data fetch error:', error);
  }
  
  const totalTrains = timetableData ? timetableData.trains.length : 0;
  const activePercentage = totalTrains > 0 ? Math.round((activeTrains / totalTrains) * 100) : 0;
  
  // Weather - only update every 30 minutes
  if (!cachedWeather || (Date.now() - lastWeatherUpdate > 1800000)) {
    const weatherConditions = ['Clear', 'Light Rain', 'Fog', 'Strong Winds', 'Overcast', 'Drizzle'];
    cachedWeather = weatherConditions[Math.floor(Math.random() * weatherConditions.length)];
    lastWeatherUpdate = Date.now();
  }
  
  const fleetBreakdown = getFleetBreakdown(activeTrainsList);
  const directionBreakdown = getDirectionBreakdown(activeTrainsList);
  const busiestStation = getBusiestStation(activeTrainsList);
  const totalUpcomingDepartures = getTotalUpcomingDepartures(currentSeconds);
  
  dashboardContent.innerHTML = `
    <div class="dashboard-stats">
      <div class="stat-card">
        <div class="stat-value">${activeTrains}</div>
        <div class="stat-label">Active Trains</div>
        <div class="stat-sub">of ${totalTrains} total (${activePercentage}%)</div>
      </div>
      <div class="stat-card ${delayedTrains > 0 ? 'danger' : ''}">
        <div class="stat-value">${delayedTrains}</div>
        <div class="stat-label">Delayed</div>
      </div>
      <div class="stat-card ${cancelledServices > 0 ? 'danger' : ''}">
        <div class="stat-value">${cancelledServices}</div>
        <div class="stat-label">Cancelled</div>
      </div>
      <div class="stat-card ${activeOverrides > 0 ? 'warning' : ''}">
        <div class="stat-value">${activeOverrides}</div>
        <div class="stat-label">Platform Changes</div>
      </div>
    </div>
    
    <div class="dashboard-stats" style="margin-top: 12px;">
      <div class="stat-card">
        <div class="stat-value">${totalUpcomingDepartures}</div>
        <div class="stat-label">Upcoming (2h)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${shortTerminated}</div>
        <div class="stat-label">Short Terminated</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${expressRunning}</div>
        <div class="stat-label">Express Running</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${recentNotes.length}</div>
        <div class="stat-label">Staff Notes</div>
      </div>
    </div>
    
    <div class="dashboard-grid">
      <div class="dashboard-section">
        <h4>🌤 Current Conditions</h4>
        <div class="dashboard-info-row">
          <span>Weather:</span>
          <span>${cachedWeather} <small style="color: #64748b;">(updated ${new Date(lastWeatherUpdate).toLocaleTimeString()})</small></span>
        </div>
        <div class="dashboard-info-row">
          <span>System Time:</span>
          <span>${now.toLocaleTimeString()}</span>
        </div>
        <div class="dashboard-info-row">
          <span>Active Staff:</span>
          <span>${currentAdminUser}</span>
        </div>
        <div class="dashboard-info-row">
          <span>Total Fleet:</span>
          <span>${totalTrains} trains</span>
        </div>
      </div>
      
      <div class="dashboard-section">
        <h4>⚠️ Active Alerts</h4>
        ${delayedTrains > 0 ? `<div class="alert-item alert-danger">🔴 ${delayedTrains} trains running late</div>` : ''}
        ${cancelledServices > 0 ? `<div class="alert-item alert-danger">🚫 ${cancelledServices} cancellations</div>` : ''}
        ${shortTerminated > 0 ? `<div class="alert-item alert-warning">⚠️ ${shortTerminated} short terminated</div>` : ''}
        ${expressRunning > 0 ? `<div class="alert-item alert-info">ℹ️ ${expressRunning} running express</div>` : ''}
        ${activeOverrides > 0 ? `<div class="alert-item alert-warning">🔄 ${activeOverrides} platform changes</div>` : ''}
        ${delayedTrains === 0 && cancelledServices === 0 && shortTerminated === 0 && activeOverrides === 0 ? '<div class="alert-item alert-success">✅ No active alerts</div>' : ''}
      </div>
      
      <div class="dashboard-section">
        <h4>🚆 Active Fleet Breakdown</h4>
        ${fleetBreakdown}
      </div>
      
      <div class="dashboard-section">
        <h4>🧭 Direction Breakdown</h4>
        ${directionBreakdown}
      </div>
      
      <div class="dashboard-section">
        <h4>🏢 Busiest Stations</h4>
        ${busiestStation}
      </div>
      
      <div class="dashboard-section">
        <h4>📝 Recent Notes</h4>
        ${recentNotes.length > 0 ? recentNotes.map(note => {
          const targetName = note.note_type === 'station' 
            ? (stationLookup[note.target_id]?.name || note.target_id)
            : note.target_id;
          return `
            <div class="dashboard-note-item">
              <div class="note-icon">${note.note_type === 'station' ? '🏢' : '🚆'}</div>
              <div class="note-content">
                <strong>${targetName}</strong><br>
                <small>${note.content.substring(0, 60)}${note.content.length > 60 ? '...' : ''}</small>
                <div class="note-meta">${note.author} • ${new Date(note.timestamp).toLocaleTimeString()}</div>
              </div>
            </div>
          `;
        }).join('') : '<p style="color: #64748b;">No recent notes</p>'}
      </div>
    </div>
    
    <div class="dashboard-footer">
      <span class="live-indicator">● LIVE</span> Auto-updating every 0.5s • Last updated: ${now.toLocaleTimeString()}
    </div>
  `;
}

function stopDashboardLive() {
  if (dashboardInterval) {
    clearInterval(dashboardInterval);
    dashboardInterval = null;
  }
}

function startDashboardLive() {
  if (dashboardInterval) {
    clearInterval(dashboardInterval);
    dashboardInterval = null;
  }
  
  const dashboardContent = document.getElementById('dashboardContent');
  if (!dashboardContent) return;
  
  updateDashboard();
  
  dashboardInterval = setInterval(() => {
    const panel = document.getElementById('adminPanel');
    const dashboardTab = document.querySelector('[data-tab="dashboardPanel"]');
    if (panel && !panel.classList.contains('hidden') && dashboardTab && dashboardTab.classList.contains('active')) {
      updateDashboard();
    } else if (dashboardInterval) {
      clearInterval(dashboardInterval);
      dashboardInterval = null;
    }
  }, 500);
}

/* ================================================================
   FEATURE 6: QUICK TRAIN LOOKUP
   ================================================================ */

function quickTrainLookup() {
  const searchInput = document.getElementById('adminTrainSearch').value.trim().toUpperCase();
  
  if (!searchInput) {
    alert('Please enter a train ID');
    return;
  }
  
  const train = timetableData.trains.find(t => t.trainId === searchInput);
  
  if (!train) {
    document.getElementById('trainLookupResult').innerHTML = '<p style="color: #e74c3c;">Train not found</p>';
    return;
  }
  
  const trainStops = stopsByTrain[train.trainId];
  const currentPosition = currentTrainPositions.find(t => t.trainId === train.trainId);
  const delays = Object.values(window.trainDelays || {}).filter(d => d.trainId === train.trainId && d.active);
  const status = window.serviceStatuses?.[train.trainId];
  
  let delaysHTML = 'None';
  if (delays.length > 0) {
    delaysHTML = delays.map(d => `${d.minutes}min (${d.reason.replace(/_/g, ' ')})`).join(', ');
  }
  
  const infoHTML = `
    <div class="train-quick-info">
      <h3>🚆 ${train.trainId}</h3>
      <table style="width: 100%; margin: 10px 0;">
        <tr><td style="color: #a0a0b0;">Type:</td><td>${train.serviceType.replace(/_/g, ' ')}</td></tr>
        <tr><td style="color: #a0a0b0;">Direction:</td><td>${train.direction}</td></tr>
        <tr><td style="color: #a0a0b0;">Status:</td><td style="color: ${status?.status === 'CANCELLED' ? '#e74c3c' : '#27ae60'};">${status?.status || 'NORMAL'}</td></tr>
        <tr><td style="color: #a0a0b0;">Current Position:</td><td>${currentPosition ? stationLookup[currentPosition.currentStation.stationId]?.name : 'Not currently active'}</td></tr>
        <tr><td style="color: #a0a0b0;">Total Stops:</td><td>${trainStops.length}</td></tr>
        <tr><td style="color: #a0a0b0;">Active Delays:</td><td>${delaysHTML}</td></tr>
      </table>
      <div class="quick-actions" style="display: flex; gap: 8px; margin-top: 12px;">
        <button onclick="showFullTimetable(['${train.trainId}'], '${trainStops[0].stationId}', '${trainStops[trainStops.length-1].stationId}')" class="export-btn" style="font-size: 0.75rem;">📅 Full Schedule</button>
        <button onclick="document.getElementById('serviceTrainId').value='${train.trainId}'; switchAdminTabByName('servicePanel')" class="export-btn" style="font-size: 0.75rem;">⚠️ Change Status</button>
        <button onclick="document.getElementById('delayTrainId').value='${train.trainId}'; switchAdminTabByName('delayPanel')" class="export-btn" style="font-size: 0.75rem;">⏰ Log Delay</button>
      </div>
    </div>
  `;
  
  document.getElementById('trainLookupResult').innerHTML = infoHTML;
}

/* ================================================================
   FEATURE 7: STATION LIVE MONITOR (Auto-updating every 0.5s)
   ================================================================ */

   let stationMonitorInterval = null;

   function populateStationMonitorDropdown() {
     const monitorStationSelect = document.getElementById('monitorStation');
     if (!monitorStationSelect || monitorStationSelect.options.length > 0) return;
     
     monitorStationSelect.innerHTML = '';
     timetableData.stations.forEach(station => {
       monitorStationSelect.add(new Option(station.name, station.stationId));
     });
   }
   
   function updateStationMonitor() {
     // Clear any existing interval
     if (stationMonitorInterval) {
       clearInterval(stationMonitorInterval);
       stationMonitorInterval = null;
     }
     
     const stationId = document.getElementById('monitorStation').value;
     if (!stationId) {
       alert('Please select a station');
       return;
     }
     
     // Store the selected station ID
     const selectedStationId = stationId;
     
     // Initial render
     const resultDiv = document.getElementById('stationMonitorResult');
     resultDiv.innerHTML = monitorStation(selectedStationId);
     
     // Set up auto-refresh every 0.5 seconds
     stationMonitorInterval = setInterval(() => {
       // Re-check the station dropdown in case user changed it
       const currentStationId = document.getElementById('monitorStation').value;
       if (currentStationId) {
         resultDiv.innerHTML = monitorStation(currentStationId);
       }
     }, 500); // 500 milliseconds = 0.5 seconds
   }
   
   // Optional: Stop auto-refresh when switching away from station monitor tab
   function stopStationMonitor() {
     if (stationMonitorInterval) {
       clearInterval(stationMonitorInterval);
       stationMonitorInterval = null;
     }
   }
   
   function monitorStation(stationId) {
     const station = stationLookup[stationId];
     if (!station) return '<p>Station not found</p>';
     
     const stops = stopsByStation[stationId] || [];
     const now = getGMT12Seconds();
     
     // Upcoming departures in next 120 minutes (2 hours)
     const upcomingDepartures = stops
       .filter(s => s.departure)
       .map(s => {
         const depTime = toSeconds(s.departure);
         let diff = depTime - now;
         if (diff < 0) diff += 86400;
         return { ...s, timeUntil: diff };
       })
       .filter(s => s.timeUntil > -60 && s.timeUntil < 7200)
       .sort((a, b) => a.timeUntil - b.timeUntil);
     
     if (upcomingDepartures.length === 0) {
       // Still show the header with auto-update indicator
       return `
         <div class="station-monitor" style="margin-top: 16px;">
           <h3>🏢 ${station.name} - Live Monitor <span style="font-size: 0.6rem; color: #00ff88;">● LIVE</span></h3>
           <p style="color: #64748b;">No departures in the next 2 hours</p>
           <p style="font-size: 0.7rem; color: #64748b;">Auto-updating every 0.5s</p>
         </div>
       `;
     }
     
     // Group by platform
     const platforms = {};
     upcomingDepartures.forEach(stop => {
       const p = getPlatformForStop(stop);
       if (!platforms[p]) platforms[p] = [];
       platforms[p].push(stop);
     });
     
     function formatCountdown(seconds) {
       if (seconds <= 0) return '<span style="color: #e74c3c;">Departed</span>';
       if (seconds < 60) return `<span style="color: #e74c3c;">${seconds}s</span>`;
       if (seconds < 3600) return `<span style="color: #e67e22;">${Math.floor(seconds/60)}m ${seconds % 60}s</span>`;
       return `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`;
     }
     
     return `
       <div class="station-monitor" style="margin-top: 16px;">
         <h3>🏢 ${station.name} - Live Monitor <span style="font-size: 0.6rem; color: #00ff88;">● LIVE</span></h3>
         <p style="color: #a0a0b0; margin-bottom: 12px;">${upcomingDepartures.length} departures in next 2 hours • Updates every 0.5s</p>
         <div class="platform-grid">
           ${Object.entries(platforms).sort(([a], [b]) => parseInt(a) - parseInt(b)).map(([platform, stops]) => `
             <div class="platform-card ${stops.length > 1 ? 'busy' : ''}">
               <div class="platform-number">P${platform}</div>
               <div class="platform-stops">
                 ${stops.map(s => `
                   <div class="platform-stop">
                     <strong>${s.trainId}</strong> ${formatCountdown(s.timeUntil)}
                   </div>
                 `).join('')}
               </div>
             </div>
           `).join('')}
         </div>
       </div>
     `;
   }

/* ================================================================
   FEATURE 8: BATCH OPERATIONS
   ================================================================ */

function populateBatchStationDropdown() {
  const batchStationSelect = document.getElementById('batchStation');
  if (!batchStationSelect || batchStationSelect.options.length > 0) return;
  
  batchStationSelect.innerHTML = '';
  timetableData.stations.forEach(station => {
    batchStationSelect.add(new Option(station.name, station.stationId));
  });
}

async function batchDelayTrains() {
  const stationId = document.getElementById('batchStation').value;
  const delayMinutes = parseInt(document.getElementById('batchDelay').value);
  const reason = document.getElementById('batchReason').value;
  
  if (!stationId || !delayMinutes) {
    alert('Please select station and delay amount');
    return;
  }
  
  const affectedStops = stopsByStation[stationId] || [];
  const affectedTrains = new Set(affectedStops.map(s => s.trainId));
  
  let count = 0;
  
  for (const trainId of affectedTrains) {
    const trainStops = stopsByTrain[trainId];
    const now = getGMT12Seconds();
    const stationStop = trainStops.find(s => s.stationId === stationId);
    if (stationStop && toSeconds(stationStop.departure || stationStop.arrival) > now) {
      const delayKey = `${trainId}_batch_${Date.now()}_${count}`;
      
      try {
        const { error } = await supabase
          .from('train_delays')
          .insert([{
            id: delayKey,
            train_id: trainId,
            minutes: delayMinutes,
            reason: reason,
            logged_by: currentAdminUser,
            timestamp: new Date().toISOString(),
            active: true
          }]);
        
        if (error) throw error;
        count++;
      } catch (error) {
        console.error('Batch delay error for train', trainId, error);
      }
    }
  }
  
  logAdminAction('BATCH_DELAY', `Applied ${delayMinutes}min delay to ${count} trains at ${stationLookup[stationId]?.name}`);
  alert(`Delayed ${count} trains passing through ${stationLookup[stationId]?.name}`);
  await refreshActiveDelays();
}

/* ================================================================
   POPULATE ADMIN DROPDOWNS
   ================================================================ */

   function populateAdminDropdowns() {
    if (!timetableData || !timetableData.stations) return;
    
    // Platform override station dropdown
    const platformStationSelect = document.getElementById('platformStation');
    if (platformStationSelect && platformStationSelect.options.length === 0) {
      platformStationSelect.innerHTML = '';
      timetableData.stations.forEach(station => {
        platformStationSelect.add(new Option(station.name, station.stationId));
      });
    }
    
    // Termination station dropdown
    const terminationStationSelect = document.getElementById('terminationStation');
    if (terminationStationSelect && terminationStationSelect.options.length === 0) {
      terminationStationSelect.innerHTML = '';
      timetableData.stations.forEach(station => {
        terminationStationSelect.add(new Option(station.name, station.stationId));
      });
    }
    
    // Station monitor dropdown
    const monitorStationSelect = document.getElementById('monitorStation');
    if (monitorStationSelect && monitorStationSelect.options.length === 0 && timetableData.stations) {
      monitorStationSelect.innerHTML = '';
      timetableData.stations.forEach(station => {
        monitorStationSelect.add(new Option(station.name, station.stationId));
      });
    }
    
    // Batch station dropdown
    const batchStationSelect = document.getElementById('batchStation');
    if (batchStationSelect && batchStationSelect.options.length === 0 && timetableData.stations) {
      batchStationSelect.innerHTML = '';
      timetableData.stations.forEach(station => {
        batchStationSelect.add(new Option(station.name, station.stationId));
      });
    }
    
    // Notes target dropdown
    if (typeof updateNoteTargets === 'function') {
      updateNoteTargets();
    }
  }

/* ================================================================
   REFRESH ALL ADMIN DISPLAYS
   ================================================================ */



/* ================================================================
   INITIALIZE EVERYTHING ON PAGE LOAD
   ================================================================ */

   document.addEventListener('DOMContentLoaded', () => {
    // Initialize theme switcher immediately
    initThemeSwitcher();
    
    // Initialize admin system after data loads
    setTimeout(() => {
      if (timetableData) {
        initAdminSystem();
      } else {
        const checkDataInterval = setInterval(() => {
          if (timetableData) {
            clearInterval(checkDataInterval);
            initAdminSystem();
          }
        }, 500);
      }
    }, 1000);
  });

/* ================================================================
   THEME SWITCHER
   ================================================================ */

   function initThemeSwitcher() {
    // Load saved theme
    const savedTheme = localStorage.getItem('sc_theme') || 'lavender';
    applyTheme(savedTheme);
    
    // Add click handlers to theme buttons
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.dataset.theme;
        applyTheme(theme);
        localStorage.setItem('sc_theme', theme);
      });
    });
  }
  
  function applyTheme(theme) {
    // Update the data-theme attribute on html element
    document.documentElement.setAttribute('data-theme', theme);
    
    // Update active state on buttons
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
  }

/* ================================================================
   USER LOGIN SYSTEM
   ================================================================ */

// User state
let currentUser = null;
let userDropdownVisible = false;

// User storage (in a real app, this would be on a server)
if (!window.userAccounts) window.userAccounts = {};
if (!window.userData) window.userData = {};

// Update the initUserSystem function to create buttons
function initUserSystem() {
  // Check for existing session
  const savedUid = localStorage.getItem('sc_current_user');
  
  if (savedUid) {
    // Try to restore session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session && session.user.id === savedUid) {
        // Fetch user profile
        const { data: userData, error } = await supabase
          .from('users')
          .select('*')
          .eq('id', savedUid)
          .single();
        
        if (!error && userData) {
          currentUser = {
            uid: savedUid,
            username: userData.username,
            email: userData.email,
            defaultClass: userData.default_class,
            balance: userData.balance,
            totalTrips: userData.total_trips,
            totalSpent: userData.total_spent,
            memberSince: userData.member_since,
            savedJourneys: userData.saved_journeys || [],
            recentSearches: userData.recent_searches || [],
            bookings: userData.bookings || [],
            preferences: userData.preferences || {}
          };
          updateUserUI();
          setupUserRealtimeListener(savedUid);
        }
      } else if (savedUid) {
        // Session expired, clear localStorage
        localStorage.removeItem('sc_current_user');
      }
    });
  }
  
  // Find the login button (now in HTML)
  const userLoginBtnVisible = document.getElementById('userLoginBtn_visible');
  if (userLoginBtnVisible) {
    userLoginBtnVisible.removeEventListener('click', userLoginBtnVisible._listener);
    userLoginBtnVisible._listener = () => {
      if (currentUser) {
        toggleUserDropdown();
      } else {
        showUserAuth();
      }
    };
    userLoginBtnVisible.addEventListener('click', userLoginBtnVisible._listener);
  }
  
  // Find the profile button (now in HTML)
  const userProfileBtn = document.getElementById('userProfileBtn');
  if (userProfileBtn) {
    userProfileBtn.removeEventListener('click', userProfileBtn._listener);
    userProfileBtn._listener = (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleUserDropdown();
    };
    userProfileBtn.addEventListener('click', userProfileBtn._listener);
    userProfileBtn.style.cursor = 'pointer';
    userProfileBtn.style.pointerEvents = 'auto';
  }
  
  // Ensure modal exists and attach all modal button listeners
  let modal = document.getElementById('userAuthModal');
  if (!modal) {
    createUserAuthModal();
    modal = document.getElementById('userAuthModal');
  }
  // Attach listeners for modal buttons (even if modal already existed)
  setupModalEventListeners();
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const profileBtn = document.getElementById('userProfileBtn');
    const dropdown = document.getElementById('userDropdown');
    const loginBtn = document.getElementById('userLoginBtn_visible');
    if (userDropdownVisible && 
        profileBtn && !profileBtn.contains(e.target) && 
        dropdown && !dropdown.contains(e.target) &&
        loginBtn && !loginBtn.contains(e.target)) {
      closeUserDropdown();
    }
  });
}
  
  // Find the login button (now in HTML)
  const userLoginBtnVisible = document.getElementById('userLoginBtn_visible');
  if (userLoginBtnVisible) {
    userLoginBtnVisible.removeEventListener('click', userLoginBtnVisible._listener);
    userLoginBtnVisible._listener = () => {
      if (currentUser) {
        toggleUserDropdown();
      } else {
        showUserAuth();
      }
    };
    userLoginBtnVisible.addEventListener('click', userLoginBtnVisible._listener);
  }
  
  // Find the profile button (now in HTML)
  const userProfileBtn = document.getElementById('userProfileBtn');
  if (userProfileBtn) {
    userProfileBtn.removeEventListener('click', userProfileBtn._listener);
    userProfileBtn._listener = (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleUserDropdown();
    };
    userProfileBtn.addEventListener('click', userProfileBtn._listener);
    userProfileBtn.style.cursor = 'pointer';
    userProfileBtn.style.pointerEvents = 'auto';
  }
  
  // Ensure modal exists and attach all modal button listeners
  let modal = document.getElementById('userAuthModal');
  if (!modal) {
    createUserAuthModal();
    modal = document.getElementById('userAuthModal');
  }
  // Attach listeners for modal buttons (even if modal already existed)
  setupModalEventListeners();
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const profileBtn = document.getElementById('userProfileBtn');
    const dropdown = document.getElementById('userDropdown');
    const loginBtn = document.getElementById('userLoginBtn_visible');
    if (userDropdownVisible && 
        profileBtn && !profileBtn.contains(e.target) && 
        dropdown && !dropdown.contains(e.target) &&
        loginBtn && !loginBtn.contains(e.target)) {
      closeUserDropdown();
    }
  });
}

// Load user data from localStorage
function loadUserData() {
  try {
    const accounts = localStorage.getItem('sc_user_accounts');
    const data = localStorage.getItem('sc_user_data');
    if (accounts) window.userAccounts = JSON.parse(accounts);
    if (data) window.userData = JSON.parse(data);
  } catch (e) {
    console.warn('Failed to load user data:', e);
  }
}

// Save user data to localStorage
function saveUserData() {
  try {
    localStorage.setItem('sc_user_accounts', JSON.stringify(window.userAccounts));
    localStorage.setItem('sc_user_data', JSON.stringify(window.userData));
  } catch (e) {
    console.warn('Failed to save user data:', e);
  }
}

// Show/hide auth modal
function showUserAuth() {
  let modal = document.getElementById('userAuthModal');
  if (!modal) {
    createUserAuthModal();
    modal = document.getElementById('userAuthModal');
  }
  
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
  
  const userLoginError = document.getElementById('userLoginError');
  if (userLoginError) userLoginError.style.display = 'none';
  
  // Clear fields
  const loginId = document.getElementById('userLoginId');
  const loginPassword = document.getElementById('userLoginPassword');
  if (loginId) loginId.value = '';
  if (loginPassword) loginPassword.value = '';
  
  showLoginForm();
}

function hideUserAuth() {
  console.log('hideUserAuth called');
  const modal = document.getElementById('userAuthModal');
  if (modal) {
    // Force hide with multiple approaches
    modal.classList.add('hidden');
    modal.style.display = 'none';
    modal.style.visibility = 'hidden';
    modal.setAttribute('aria-hidden', 'true');
    // Remove any inline style that might show it
    modal.removeAttribute('style');
    modal.style.display = 'none';
    modal.style.visibility = 'hidden';
    
    // Also hide the backdrop overlay if any
    const overlays = document.querySelectorAll('.modal-backdrop, .popup-overlay');
    overlays.forEach(overlay => overlay.remove());
  } else {
    console.warn('Modal not found in hideUserAuth');
  }
  
  // Clear form fields
  const loginId = document.getElementById('userLoginId');
  const loginPassword = document.getElementById('userLoginPassword');
  if (loginId) loginId.value = '';
  if (loginPassword) loginPassword.value = '';
  
  const userLoginError = document.getElementById('userLoginError');
  if (userLoginError) userLoginError.style.display = 'none';
  
  // Reset to login form
  const loginForm = document.getElementById('userLoginForm');
  const registerForm = document.getElementById('userRegisterForm');
  if (loginForm) loginForm.style.display = 'block';
  if (registerForm) registerForm.style.display = 'none';
}

function showLoginForm() {
  const loginForm = document.getElementById('userLoginForm');
  const registerForm = document.getElementById('userRegisterForm');
  const userLoginError = document.getElementById('userLoginError');
  const regError = document.getElementById('regError');
  const regSuccess = document.getElementById('regSuccess');
  
  if (loginForm) loginForm.style.display = 'block';
  if (registerForm) registerForm.style.display = 'none';
  if (userLoginError) userLoginError.style.display = 'none';
  if (regError) regError.style.display = 'none';
  if (regSuccess) regSuccess.style.display = 'none';
}

function showRegisterForm() {
  const loginForm = document.getElementById('userLoginForm');
  const registerForm = document.getElementById('userRegisterForm');
  const regError = document.getElementById('regError');
  const regSuccess = document.getElementById('regSuccess');
  
  if (loginForm) loginForm.style.display = 'none';
  if (registerForm) registerForm.style.display = 'block';
  if (regError) regError.style.display = 'none';
  if (regSuccess) regSuccess.style.display = 'none';
}

// User login
// Replace the existing userLogin function
async function userLogin() {
  const loginId = document.getElementById('userLoginId').value.trim();
  const password = document.getElementById('userLoginPassword').value;
  const errorElement = document.getElementById('userLoginError');
  
  if (!loginId || !password) {
    if (errorElement) {
      errorElement.textContent = 'Please enter both email and password';
      errorElement.style.display = 'block';
    }
    return;
  }
  
  try {
    // Determine if loginId is email or username
    let email = loginId;
    
    // If loginId doesn't contain @, try to find email by username
    if (!loginId.includes('@')) {
      const { data: userData, error: findError } = await supabase
        .from('users')
        .select('email')
        .eq('username', loginId)
        .single();
      
      if (findError && findError.code !== 'PGRST116') {
        // PGRST116 means no rows returned
        throw new Error('Username not found');
      }
      
      if (userData) {
        email = userData.email;
      } else {
        throw new Error('Username not found');
      }
    }
    
    // Sign in with Supabase Auth
    const { data: authData, error: signInError } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });
    
    if (signInError) throw signInError;
    
    const uid = authData.user.id;
    
    // Fetch user profile from users table
    const { data: userData, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', uid)
      .single();
    
    if (fetchError) throw fetchError;
    
    // Set current user
    currentUser = {
      uid: uid,
      username: userData.username,
      email: userData.email,
      defaultClass: userData.default_class,
      balance: userData.balance,
      totalTrips: userData.total_trips,
      totalSpent: userData.total_spent,
      memberSince: userData.member_since,
      savedJourneys: userData.saved_journeys || [],
      recentSearches: userData.recent_searches || [],
      bookings: userData.bookings || [],
      preferences: userData.preferences || {}
    };
    
    // Store UID in localStorage for session persistence
    localStorage.setItem('sc_current_user', uid);
    
    // Set up real-time listener for this user
    if (typeof setupUserRealtimeListener === 'function') {
      setupUserRealtimeListener(uid);
    }
    
    // Close modal and update UI
    hideUserAuth();
    updateUserUI();
    
    console.log(`[USER] ${currentUser.username} logged in`);
    showTemporaryMessage(`Welcome back, ${currentUser.username}!`, 'success');
    
  } catch (error) {
    console.error('Login error:', error);
    if (errorElement) {
      errorElement.textContent = error.message;
      errorElement.style.display = 'block';
    }
  }
}

// Replace the existing userRegister function
async function userRegister() {
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirmPassword = document.getElementById('regConfirmPassword').value;
  const defaultClass = document.getElementById('regDefaultClass').value;
  const errorEl = document.getElementById('regError');
  const successEl = document.getElementById('regSuccess');
  
  // Reset messages
  if (errorEl) errorEl.style.display = 'none';
  if (successEl) successEl.style.display = 'none';
  
  if (!username || !email || !password || !confirmPassword) {
    if (errorEl) {
      errorEl.textContent = 'Please fill in all fields';
      errorEl.style.display = 'block';
    }
    return;
  }
  
  if (username.length < 3) {
    if (errorEl) {
      errorEl.textContent = 'Username must be at least 3 characters';
      errorEl.style.display = 'block';
    }
    return;
  }
  
  if (!email.includes('@') || !email.includes('.')) {
    if (errorEl) {
      errorEl.textContent = 'Please enter a valid email address';
      errorEl.style.display = 'block';
    }
    return;
  }
  
  if (password.length < 6) {
    if (errorEl) {
      errorEl.textContent = 'Password must be at least 6 characters';
      errorEl.style.display = 'block';
    }
    return;
  }
  
  if (password !== confirmPassword) {
    if (errorEl) {
      errorEl.textContent = 'Passwords do not match';
      errorEl.style.display = 'block';
    }
    return;
  }
  
  try {
    // 1. Sign up with Supabase Auth
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email: email,
      password: password,
      options: {
        data: {
          username: username,
          default_class: defaultClass
        }
      }
    });
    
    if (signUpError) throw signUpError;
    
    if (!authData.user) {
      throw new Error('Signup failed - no user returned');
    }
    
    const uid = authData.user.id;
    
    // 2. Insert user profile into public.users table
    const { error: insertError } = await supabase
      .from('users')
      .insert([{
        id: uid,
        username: username,
        email: email,
        default_class: defaultClass,
        balance: 50,
        total_trips: 0,
        total_spent: 0,
        member_since: new Date().toISOString(),
        saved_journeys: [],
        recent_searches: [],
        bookings: [],
        preferences: { defaultClass: defaultClass, notifications: true }
      }]);
    
    if (insertError) throw insertError;
    
    if (successEl) {
      successEl.textContent = 'Account created successfully! You can now login.';
      successEl.style.display = 'block';
    }
    
    // Clear form
    document.getElementById('regUsername').value = '';
    document.getElementById('regEmail').value = '';
    document.getElementById('regPassword').value = '';
    document.getElementById('regConfirmPassword').value = '';
    
    // Switch to login after 2 seconds
    setTimeout(() => {
      showLoginForm();
      document.getElementById('userLoginId').value = email;
      if (successEl) successEl.style.display = 'none';
    }, 2000);
    
  } catch (error) {
    console.error('Registration error:', error);
    if (errorEl) {
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
    }
  }
}

// Helper function to show temporary messages
function showTemporaryMessage(message, type) {
  const resultsDiv = document.getElementById('results');
  if (!resultsDiv) return;
  
  const msgDiv = document.createElement('div');
  msgDiv.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    background: ${type === 'success' ? '#27ae60' : '#e74c3c'};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    z-index: 10000;
    animation: slideIn 0.3s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  `;
  msgDiv.textContent = message;
  document.body.appendChild(msgDiv);
  
  setTimeout(() => {
    msgDiv.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => msgDiv.remove(), 300);
  }, 3000);
}

// Update UI for logged in user
function updateUserUI() {
  const loginBtn = document.getElementById('userLoginBtn_visible');
  const profileBtn = document.getElementById('userProfileBtn');
  const displayName = document.getElementById('userDisplayName');
  
  console.log('updateUserUI called, currentUser:', currentUser);
  
  if (currentUser) {
    // Show profile button, hide login button
    if (loginBtn) {
      loginBtn.style.display = 'none';
      loginBtn.style.visibility = 'hidden';
    }
    if (profileBtn) {
      profileBtn.classList.remove('hidden');
      profileBtn.style.display = 'flex';
      profileBtn.style.visibility = 'visible';
      profileBtn.style.pointerEvents = 'auto';
      profileBtn.style.cursor = 'pointer';
    }
    if (displayName) displayName.textContent = currentUser.username;
    
    // Add or update the user info bar (balance, greeting)
    addUserInfoBar();
  } else {
    // Show login button, hide profile button
    if (loginBtn) {
      loginBtn.style.display = 'inline-block';
      loginBtn.style.visibility = 'visible';
    }
    if (profileBtn) {
      profileBtn.classList.add('hidden');
      profileBtn.style.display = 'none';
      profileBtn.style.visibility = 'hidden';
    }
    
    // Remove info bar
    const infoBar = document.querySelector('.user-info-bar');
    if (infoBar) infoBar.remove();
  }
}

// Helper to create or update the user info bar (call this whenever balance might change)
function addUserInfoBar() {
  if (!currentUser) return;
  
  // Remove existing bar to avoid duplication
  const existingBar = document.querySelector('.user-info-bar');
  if (existingBar) existingBar.remove();
  
  const searchPanel = document.querySelector('.search-panel');
  if (!searchPanel) return;
  
  const infoBar = document.createElement('div');
  infoBar.className = 'user-info-bar';
  infoBar.innerHTML = `
    <span class="user-greeting">👋 Welcome, ${escapeHtml(currentUser.username)}!</span>
    <span class="user-balance">💰 Balance: ${(currentUser.balance || 0).toFixed(2)} DSD</span>
  `;
  
  searchPanel.parentNode.insertBefore(infoBar, searchPanel);
}

// Toggle user dropdown
function toggleUserDropdown() {
  console.log('toggleUserDropdown called, current state:', userDropdownVisible);
  if (userDropdownVisible) {
    closeUserDropdown();
  } else {
    showUserDropdown();
  }
}

function showUserDropdown() {
  closeUserDropdown();
  
  const profileBtn = document.getElementById('userProfileBtn');
  if (!profileBtn) {
    console.error('Profile button not found');
    return;
  }
  
  const dropdown = document.createElement('div');
  dropdown.className = 'user-dropdown';
  dropdown.id = 'userDropdown';
  dropdown.innerHTML = `
    <div class="user-dropdown-item" onclick="viewUserProfile()">👤 My Profile</div>
    <div class="user-dropdown-item" onclick="viewSavedJourneys()">💾 Saved Journeys</div>
    <div class="user-dropdown-item" onclick="viewRecentSearches()">🕐 Recent Searches</div>
    <div class="user-dropdown-item" onclick="viewMyBookings()">🎫 My Bookings</div>
    <div class="user-dropdown-divider"></div>
    <div class="user-dropdown-item" onclick="topUpBalance()">💰 Top Up Balance</div>
    <div class="user-dropdown-divider"></div>
    <div class="user-dropdown-item danger" onclick="userLogout()">🚪 Logout</div>
  `;
  
  // Position the dropdown relative to the profile button
  profileBtn.style.position = 'relative';
  profileBtn.appendChild(dropdown);
  userDropdownVisible = true;
  console.log('Dropdown shown');
}

function closeUserDropdown() {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) {
    dropdown.remove();
  }
  userDropdownVisible = false;
  console.log('Dropdown closed');
}

// User logout
// Global variable for unsubscribe function (declare at top of file with other globals)
let userUnsubscribe = null;

// Setup real-time listener for user data
function setupUserRealtimeListener(uid) {
  // Unsubscribe from previous listener if exists
  if (userUnsubscribe) {
    userUnsubscribe();
    userUnsubscribe = null;
  }
  
  // Create new subscription
  const subscription = supabase
    .channel(`user-${uid}`)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'users',
      filter: `id=eq.${uid}`
    }, (payload) => {
      // Update currentUser with new data from database
      if (payload.new && currentUser) {
        currentUser = {
          ...currentUser,
          username: payload.new.username,
          email: payload.new.email,
          defaultClass: payload.new.default_class,
          balance: payload.new.balance,
          totalTrips: payload.new.total_trips,
          totalSpent: payload.new.total_spent,
          savedJourneys: payload.new.saved_journeys || [],
          recentSearches: payload.new.recent_searches || [],
          bookings: payload.new.bookings || [],
          preferences: payload.new.preferences || {}
        };
        updateUserUI();
        console.log('User data updated from database');
      }
    })
    .subscribe();
  
  userUnsubscribe = () => {
    subscription.unsubscribe();
  };
}

// User logout function
async function userLogout() {
  // Unsubscribe from real-time updates
  if (userUnsubscribe) {
    userUnsubscribe();
    userUnsubscribe = null;
  }
  
  // Sign out from Supabase Auth
  const { error } = await supabase.auth.signOut();
  if (error) console.error('Logout error:', error);
  
  // Clear local state
  currentUser = null;
  localStorage.removeItem('sc_current_user');
  
  // Close dropdown and update UI
  closeUserDropdown();
  updateUserUI();
  
  console.log('[USER] Logged out');
  showTemporaryMessage('You have been logged out.', 'info');
}

// View user profile
function viewUserProfile() {
  closeUserDropdown();
  
  if (!currentUser) return;
  
  const resultsDiv = document.getElementById('results');
  const userData = window.userData[currentUser.username];
  
  resultsDiv.innerHTML = `
    <div class="live-board-container" style="background: linear-gradient(135deg, #faf8fc 0%, #f0ebf5 100%); color: var(--text); border-color: var(--border);">
      <h2 style="color: var(--heading-accent);">👤 My Profile</h2>
      
      <div class="dashboard-grid" style="margin-top: 16px;">
        <div class="dashboard-section">
          <h4>Account Info</h4>
          <div class="dashboard-info-row">
            <span>Username:</span>
            <span>${currentUser.username}</span>
          </div>
          <div class="dashboard-info-row">
            <span>Email:</span>
            <span>${currentUser.email}</span>
          </div>
          <div class="dashboard-info-row">
            <span>Member Since:</span>
            <span>${new Date(currentUser.memberSince).toLocaleDateString()}</span>
          </div>
          <div class="dashboard-info-row">
            <span>Default Class:</span>
            <span>${currentUser.defaultClass || 'Third'} Class</span>
          </div>
        </div>
        
        <div class="dashboard-section">
          <h4>Travel Stats</h4>
          <div class="dashboard-info-row">
            <span>Balance:</span>
            <span style="font-weight: 700; color: var(--success);">${currentUser.balance || 0} DSD</span>
          </div>
          <div class="dashboard-info-row">
            <span>Total Trips:</span>
            <span>${currentUser.totalTrips || 0}</span>
          </div>
          <div class="dashboard-info-row">
            <span>Total Spent:</span>
            <span>${currentUser.totalSpent || 0} DSD</span>
          </div>
        </div>
      </div>
      
      <div style="margin-top: 16px; text-align: center;">
        <button class="primary" onclick="topUpBalance()">💰 Top Up Balance</button>
      </div>
    </div>
  `;
}

// View saved journeys
function viewSavedJourneys() {
  closeUserDropdown();
  
  if (!currentUser) return;
  
  const resultsDiv = document.getElementById('results');
  const savedJourneys = currentUser.savedJourneys || [];
  
  let html = `
    <div class="live-board-container" style="background: linear-gradient(135deg, #faf8fc 0%, #f0ebf5 100%); color: var(--text); border-color: var(--border);">
      <h2 style="color: var(--heading-accent);">💾 Saved Journeys</h2>
  `;
  
  if (savedJourneys.length === 0) {
    html += '<p style="text-align: center; padding: 20px; color: var(--muted);">No saved journeys yet</p>';
  } else {
    savedJourneys.forEach((journey, index) => {
      html += `
        <div class="saved-journey-item" onclick="loadSavedJourney(${index})">
          <div class="journey-route">🚆 ${journey.from} → ${journey.to}</div>
          <div class="journey-meta">
            ${journey.trainType || 'Any'} • ${journey.class || 'Third'} Class • Saved ${new Date(journey.savedAt).toLocaleDateString()}
          </div>
        </div>
      `;
    });
  }
  
  html += '</div>';
  resultsDiv.innerHTML = html;
}

// View recent searches
function viewRecentSearches() {
  closeUserDropdown();
  
  if (!currentUser) return;
  
  const resultsDiv = document.getElementById('results');
  const recentSearches = currentUser.recentSearches || [];
  
  let html = `
    <div class="live-board-container" style="background: linear-gradient(135deg, #faf8fc 0%, #f0ebf5 100%); color: var(--text); border-color: var(--border);">
      <h2 style="color: var(--heading-accent);">🕐 Recent Searches</h2>
  `;
  
  if (recentSearches.length === 0) {
    html += '<p style="text-align: center; padding: 20px; color: var(--muted);">No recent searches</p>';
  } else {
    recentSearches.slice(0, 20).forEach(search => {
      html += `
        <div class="recent-search-item" onclick="loadRecentSearch('${search.from}', '${search.to}')">
          📍 ${search.from} → ${search.to} <small style="color: var(--muted);">(${new Date(search.timestamp).toLocaleString()})</small>
        </div>
      `;
    });
  }
  
  html += '</div>';
  resultsDiv.innerHTML = html;
}

// Top up balance
async function topUpBalance() {
  closeUserDropdown();
  
  if (!currentUser) {
    alert('Please login first');
    return;
  }
  
  const amount = prompt('Enter amount to top up (DSD):', '50');
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) return;
  
  const topUpAmount = parseFloat(amount);
  const newBalance = (currentUser.balance || 0) + topUpAmount;
  
  try {
    // Update balance in Supabase
    const { error } = await supabase
      .from('users')
      .update({ balance: newBalance })
      .eq('id', currentUser.uid);
    
    if (error) throw error;
    
    // Update local state (the real-time listener will also update it)
    currentUser.balance = newBalance;
    updateUserUI();
    
    alert(`Successfully topped up ${topUpAmount} DSD! New balance: ${newBalance} DSD`);
    showTemporaryMessage(`Top-up successful! +${topUpAmount} DSD`, 'success');
    
  } catch (error) {
    console.error('Top-up error:', error);
    alert('Failed to top up balance: ' + error.message);
  }
}

// Create a new booking (called after purchase)
async function createBooking(bookingData) {
  if (!currentUser) return false;
  
  const newBookings = [...(currentUser.bookings || []), bookingData];
  const newBalance = currentUser.balance - bookingData.totalFare;
  const newTrips = (currentUser.totalTrips || 0) + 1;
  const newSpent = (currentUser.totalSpent || 0) + bookingData.totalFare;
  
  try {
    const { error } = await supabase
      .from('users')
      .update({
        bookings: newBookings,
        balance: newBalance,
        total_trips: newTrips,
        total_spent: newSpent
      })
      .eq('id', currentUser.uid);
    
    if (error) throw error;
    
    // Update local state
    currentUser.bookings = newBookings;
    currentUser.balance = newBalance;
    currentUser.totalTrips = newTrips;
    currentUser.totalSpent = newSpent;
    updateUserUI();
    
    return true;
  } catch (error) {
    console.error('Create booking error:', error);
    return false;
  }
}

async function cancelBooking(bookingId) {
  if (!currentUser || !currentUser.bookings) return;
  
  const bookingIndex = currentUser.bookings.findIndex(b => b.id === bookingId);
  if (bookingIndex === -1) return;
  
  const booking = currentUser.bookings[bookingIndex];
  const refund = booking.totalFare;
  
  if (confirm(`Cancel booking #${booking.id} for ${booking.from} → ${booking.to} on ${booking.date}? You will be refunded ${refund} DSD.`)) {
    
    // Remove booking
    const newBookings = [...currentUser.bookings];
    newBookings.splice(bookingIndex, 1);
    
    // Calculate new totals
    const newBalance = currentUser.balance + refund;
    const newTrips = currentUser.totalTrips - 1;
    const newSpent = currentUser.totalSpent - refund;
    
    try {
      const { error } = await supabase
        .from('users')
        .update({
          bookings: newBookings,
          balance: newBalance,
          total_trips: newTrips,
          total_spent: newSpent
        })
        .eq('id', currentUser.uid);
      
      if (error) throw error;
      
      // Update local state
      currentUser.bookings = newBookings;
      currentUser.balance = newBalance;
      currentUser.totalTrips = newTrips;
      currentUser.totalSpent = newSpent;
      updateUserUI();
      
      showTemporaryMessage(`Booking cancelled. Refunded ${refund} DSD.`, 'success');
      
      // Refresh the bookings view if it's currently open
      const resultsDiv = document.getElementById('results');
      if (resultsDiv && resultsDiv.innerHTML.includes('My Bookings')) {
        viewMyBookings();
      }
    } catch (error) {
      console.error('Cancel booking error:', error);
      alert('Failed to cancel booking: ' + error.message);
    }
  }
}

function viewMyBookings() {
  closeUserDropdown();
  if (!currentUser || !currentUser.bookings || currentUser.bookings.length === 0) {
    alert('No bookings found.');
    return;
  }
  
  const resultsDiv = document.getElementById('results');
  let html = `<div class="live-board-container"><h2>🎫 My Bookings</h2>`;
  
  currentUser.bookings.forEach(b => {
    html += `<div style="border-bottom:1px solid var(--border); padding:12px; position:relative;">
              <strong>#${b.id}</strong> – ${b.trainId} · ${b.from} → ${b.to}<br>
              ${b.date} ${b.departureTime} · ${b.travelClass} class · ${b.passengers.length} pax<br>
              Paid: ${b.totalFare} DSD
              <button onclick="cancelBooking(${b.id})" style="float:right; background:#e74c3c; color:white; border:none; border-radius:4px; padding:4px 10px; cursor:pointer;">Cancel</button>
             </div>`;
  });
  
  html += `</div>`;
  resultsDiv.innerHTML = html;
}

// Save a journey search
function saveCurrentJourney(fromStationId, toStationId, trainType, className) {
  if (!currentUser) return;
  
  const fromStation = stationLookup[fromStationId];
  const toStation = stationLookup[toStationId];
  
  if (!fromStation || !toStation) return;
  
  const journey = {
    from: fromStation.name,
    to: toStation.name,
    fromId: fromStationId,
    toId: toStationId,
    trainType: trainType,
    class: className || currentUser.defaultClass || 'Third',
    savedAt: new Date().toISOString()
  };
  
  if (!currentUser.savedJourneys) currentUser.savedJourneys = [];
  currentUser.savedJourneys.unshift(journey);
  
  // Keep only last 50 saved journeys
  if (currentUser.savedJourneys.length > 50) {
    currentUser.savedJourneys = currentUser.savedJourneys.slice(0, 50);
  }
  
  window.userData[currentUser.username].savedJourneys = currentUser.savedJourneys;
  saveUserData();
}

// Add recent search
function addRecentSearch(fromStationId, toStationId) {
  if (!currentUser) return;
  
  const fromStation = stationLookup[fromStationId];
  const toStation = stationLookup[toStationId];
  
  if (!fromStation || !toStation) return;
  
  const search = {
    from: fromStation.name,
    to: toStation.name,
    fromId: fromStationId,
    toId: toStationId,
    timestamp: new Date().toISOString()
  };
  
  if (!currentUser.recentSearches) currentUser.recentSearches = [];
  currentUser.recentSearches.unshift(search);
  
  // Keep only last 50 searches
  if (currentUser.recentSearches.length > 50) {
    currentUser.recentSearches = currentUser.recentSearches.slice(0, 50);
  }
  
  window.userData[currentUser.username].recentSearches = currentUser.recentSearches;
  saveUserData();
}

// Load a saved journey
function loadSavedJourney(index) {
  if (!currentUser || !currentUser.savedJourneys) return;
  
  const journey = currentUser.savedJourneys[index];
  if (!journey) return;
  
  // Set the from/to dropdowns
  const fromSelect = document.getElementById('fromStation');
  const toSelect = document.getElementById('toStation');
  
  for (let i = 0; i < fromSelect.options.length; i++) {
    if (fromSelect.options[i].value === journey.fromId) {
      fromSelect.selectedIndex = i;
      break;
    }
  }
  
  for (let i = 0; i < toSelect.options.length; i++) {
    if (toSelect.options[i].value === journey.toId) {
      toSelect.selectedIndex = i;
      break;
    }
  }
  
  // Switch to station search mode
  setMode({ btn: stationModeBtn, panel: stationSearch });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Load a recent search
function loadRecentSearch(fromName, toName) {
  const fromSelect = document.getElementById('fromStation');
  const toSelect = document.getElementById('toStation');
  
  for (let i = 0; i < fromSelect.options.length; i++) {
    if (fromSelect.options[i].text === fromName) {
      fromSelect.selectedIndex = i;
      break;
    }
  }
  
  for (let i = 0; i < toSelect.options.length; i++) {
    if (toSelect.options[i].text === toName) {
      toSelect.selectedIndex = i;
      break;
    }
  }
  
  setMode({ btn: stationModeBtn, panel: stationSearch });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Add after viewMyBookings function
function cancelBooking(bookingId) {
  if (!currentUser || !currentUser.bookings) return;
  
  const bookingIndex = currentUser.bookings.findIndex(b => b.id === bookingId);
  if (bookingIndex === -1) return;
  
  const booking = currentUser.bookings[bookingIndex];
  const refund = booking.totalFare;
  
  if (confirm(`Cancel booking #${booking.id} for ${booking.from} → ${booking.to} on ${booking.date}? You will be refunded ${refund} DSD.`)) {
    // Remove booking
    currentUser.bookings.splice(bookingIndex, 1);
    // Refund balance
    currentUser.balance += refund;
    currentUser.totalSpent -= refund;
    currentUser.totalTrips -= 1;
    
    // Update stored data
    window.userData[currentUser.username].bookings = currentUser.bookings;
    window.userData[currentUser.username].balance = currentUser.balance;
    window.userData[currentUser.username].totalSpent = currentUser.totalSpent;
    window.userData[currentUser.username].totalTrips = currentUser.totalTrips;
    saveUserData();
    updateUserUI();
    
    showTemporaryMessage(`Booking cancelled. Refunded ${refund} DSD.`, 'success');
    
    // Refresh the bookings view if it's currently open
    const resultsDiv = document.getElementById('results');
    if (resultsDiv.innerHTML.includes('My Bookings')) {
      viewMyBookings(); // re-render
    }
  }
}

// Replace viewMyBookings with this version that includes cancel buttons
function viewMyBookings() {
  closeUserDropdown();
  if (!currentUser || !currentUser.bookings || currentUser.bookings.length === 0) {
    alert('No bookings found.');
    return;
  }
  const resultsDiv = document.getElementById('results');
  let html = `<div class="live-board-container"><h2>🎫 My Bookings</h2>`;
  currentUser.bookings.forEach(b => {
    html += `<div style="border-bottom:1px solid var(--border); padding:12px; position:relative;">
              <strong>#${b.id}</strong> – ${b.trainId} · ${b.from} → ${b.to}<br>
              ${b.date} ${b.departureTime} · ${b.travelClass} class · ${b.passengers.length} pax<br>
              Paid: ${b.totalFare} DSD
              <button onclick="cancelBooking(${b.id})" style="float:right; background:#e74c3c; color:white; border:none; border-radius:4px; padding:4px 10px; cursor:pointer;">Cancel</button>
             </div>`;
  });
  html += `</div>`;
  resultsDiv.innerHTML = html;
}

/* ================================================================
   TICKET PURCHASE SYSTEM
   ================================================================ */

   let currentBooking = null;      // { fromStation, toStation, journey, selectedDate, travelClass }
   let selectedSeats = [];          // array of { passengerName, seat, car, price }
   let ticketBookingModal = null;
   
   function createTicketModal() {
     if (document.getElementById('ticketModal')) return;
     const modalHTML = `
       <div id="ticketModal" class="modal hidden" style="display: none;">
         <div class="modal-content" style="max-width: 650px; width: 90%;">
           <span class="modal-close" id="ticketModalClose">&times;</span>
           <h2>🎫 Purchase Tickets</h2>
           <div id="ticketStep1">
             <div class="form-row">
               <label>Travel date</label>
               <input type="date" id="travelDate" min="${new Date().toISOString().split('T')[0]}">
             </div>
             <div class="form-row">
               <label>Class</label>
               <select id="travelClass">
                 <option value="first">First Class</option>
                 <option value="second">Second Class</option>
                 <option value="third">Third Class</option>
               </select>
             </div>
             <div class="form-row">
               <label>Number of passengers</label>
               <input type="number" id="passengerCount" min="1" max="9" value="1">
             </div>
             <div class="form-actions">
               <button id="ticketNextBtn" class="primary">Continue to seat selection</button>
               <button id="ticketCancelBtn" class="secondary">Cancel</button>
             </div>
           </div>
           <div id="ticketStep2" style="display: none;">
             <div id="seatSelectionPanel"></div>
             <div class="form-actions" style="margin-top: 20px;">
               <button id="ticketBackBtn" class="secondary">Back</button>
               <button id="ticketConfirmBtn" class="primary">Confirm & Pay</button>
             </div>
           </div>
           <div id="ticketStep3" style="display: none;">
             <div id="bookingSummary"></div>
             <div class="form-actions">
               <button id="ticketFinishBtn" class="primary">Close</button>
             </div>
           </div>
         </div>
       </div>
     `;
     document.body.insertAdjacentHTML('beforeend', modalHTML);
     ticketBookingModal = document.getElementById('ticketModal');
     
     // Event listeners
     document.getElementById('ticketModalClose').onclick = () => closeTicketModal();
     document.getElementById('ticketCancelBtn').onclick = () => closeTicketModal();
     document.getElementById('ticketNextBtn').onclick = () => showSeatSelection();
     document.getElementById('ticketBackBtn').onclick = () => { showStep(1); };
     document.getElementById('ticketConfirmBtn').onclick = () => confirmBooking();
     document.getElementById('ticketFinishBtn').onclick = () => closeTicketModal();
     
     // Close on outside click
     ticketBookingModal.onclick = (e) => { if (e.target === ticketBookingModal) closeTicketModal(); };
   }
   
   function closeTicketModal() {
     ticketBookingModal.classList.add('hidden');
     ticketBookingModal.style.display = 'none';
     currentBooking = null;
     selectedSeats = [];
   }
   
   function showStep(step) {
     document.getElementById('ticketStep1').style.display = step === 1 ? 'block' : 'none';
     document.getElementById('ticketStep2').style.display = step === 2 ? 'block' : 'none';
     document.getElementById('ticketStep3').style.display = step === 3 ? 'block' : 'none';
   }
   
   function openTicketBooking(journey, fromStation, toStation, departureTime, trainId, serviceType) {
     if (!currentUser) {
       alert('Please login to purchase tickets.');
       showUserAuth();
       return;
     }
     createTicketModal();
     currentBooking = {
       journey, fromStation, toStation, departureTime, trainId, serviceType,
       fromName: stationLookup[fromStation]?.name || fromStation,
       toName: stationLookup[toStation]?.name || toStation
     };
     document.getElementById('travelDate').value = new Date().toISOString().split('T')[0];
     document.getElementById('passengerCount').value = 1;
     showStep(1);
     ticketBookingModal.classList.remove('hidden');
     ticketBookingModal.style.display = 'flex';
   }
   
function showSeatSelection() {
  const travelDate = document.getElementById('travelDate').value;
  const travelClass = document.getElementById('travelClass').value;
  const passengerCount = parseInt(document.getElementById('passengerCount').value, 10);
  if (!travelDate) { alert('Please select travel date'); return; }
  if (passengerCount < 1 || passengerCount > 9) { alert('Passenger count must be 1-9'); return; }
  
  currentBooking.selectedDate = travelDate;
  currentBooking.travelClass = travelClass;
  currentBooking.passengerCount = passengerCount;
  
  const availableSeats = getAvailableSeats(currentBooking.trainId, currentBooking.serviceType, travelClass);
  if (availableSeats.length === 0) {
    alert('No seats available for this class on this train.');
    return;
  }
  
  // Group seats by car
  const seatsByCar = {};
  availableSeats.forEach(seat => {
    if (!seatsByCar[seat.car]) seatsByCar[seat.car] = [];
    seatsByCar[seat.car].push(seat);
  });
  
  let html = `<h3>Select ${passengerCount} seat(s) – ${travelClass.charAt(0).toUpperCase() + travelClass.slice(1)} class</h3>`;
  html += `<p><strong>Train ${currentBooking.trainId}</strong> (${currentBooking.serviceType})<br>
           ${currentBooking.fromName} → ${currentBooking.toName}<br>
           ${currentBooking.departureTime}</p>`;
  html += `<div style="max-height: 500px; overflow-y: auto;">`;
  
  for (let carNum of Object.keys(seatsByCar).sort((a,b)=>a-b)) {
    const seats = seatsByCar[carNum];
    // Build a grid: rows A-Z, columns based on class
    // Determine max row letter
    const maxRowLetter = Math.max(...seats.map(s => s.row));
    const columns = travelClass === 'first' ? ['A','F'] : (travelClass === 'second' ? ['A','C','D','F'] : ['A','B','C','D','E','F']);
    
    html += `<div style="margin-bottom: 20px; border: 1px solid var(--border); padding: 12px; border-radius: 8px;">
              <strong>Car ${carNum}</strong>
              <table style="width:100%; margin-top:8px; border-collapse:collapse;">`;
    
    for (let row = 1; row <= maxRowLetter; row++) {
      const rowLetter = String.fromCharCode(64 + row);
      html += `<tr>`;
      html += `<td style="padding:4px; font-weight:bold; width:30px;">${rowLetter}</td>`;
      for (let col of columns) {
        const seatName = `${rowLetter}${col}`;
        const seatObj = seats.find(s => s.seat === seatName);
        const isAvailable = !!seatObj;
        const seatId = seatName;
        html += `<td style="padding:4px; text-align:center;">
                  ${isAvailable ? 
                    `<button type="button" class="seat-btn" data-car="${carNum}" data-seat="${seatName}" style="width:40px; height:40px; background:#27ae60; color:white; border:none; border-radius:4px; cursor:pointer;">${seatName}</button>` :
                    `<button disabled style="width:40px; height:40px; background:#95a5a6; border:none; border-radius:4px;">${seatName}</button>`
                  }
                </td>`;
      }
      html += `</tr>`;
    }
    html += `</table><small>Click on a seat to select/deselect. Selected seats turn orange.</small></div>`;
  }
  html += `</div>`;
  html += `<p>Selected: <span id="selectedCount">0</span> / ${passengerCount}</p>`;
  html += `<div class="form-actions" style="margin-top: 20px;">
            <button id="ticketBackBtn2" class="secondary">Back</button>
            <button id="ticketConfirmBtn2" class="primary">Proceed to payment</button>
          </div>`;
  
  document.getElementById('seatSelectionPanel').innerHTML = html;
  
  // Seat selection logic
  let selectedSeats = [];
  const seatButtons = document.querySelectorAll('.seat-btn');
  const updateSelectedCount = () => {
    document.getElementById('selectedCount').innerText = selectedSeats.length;
  };
  
  seatButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const seat = btn.dataset.seat;
      const idx = selectedSeats.indexOf(seat);
      if (idx === -1) {
        if (selectedSeats.length >= passengerCount) {
          alert(`You can only select ${passengerCount} seat(s).`);
          return;
        }
        selectedSeats.push(seat);
        btn.style.background = '#e67e22';
      } else {
        selectedSeats.splice(idx, 1);
        btn.style.background = '#27ae60';
      }
      updateSelectedCount();
    });
  });
  
  document.getElementById('ticketBackBtn2').onclick = () => { showStep(1); };
  document.getElementById('ticketConfirmBtn2').onclick = () => {
    if (selectedSeats.length !== passengerCount) {
      alert(`Please select exactly ${passengerCount} seat(s).`);
      return;
    }
    // Store selected seats for later use (they will be passed to confirmBooking)
    // We'll store them globally or as a closure variable.
    window.tempSelectedSeats = selectedSeats.map(seat => {
      const car = document.querySelector(`.seat-btn[data-seat="${seat}"]`).dataset.car;
      return { seat, car };
    });
    // Move to fare confirmation (which will ask for names)
    // We'll reuse confirmBooking but with the selected seats from temp.
    // For simplicity, we'll modify confirmBooking to use window.tempSelectedSeats.
    // We'll also remove the checkbox-based logic.
    // Let's call a new function that uses the seat map selections.
    proceedToFareConfirmation();
  };
}

async function proceedToFareConfirmation() {
  const selected = window.tempSelectedSeats || [];
  if (selected.length !== currentBooking.passengerCount) return;
  
  // Build passenger list with names
  const passengers = [];
  for (let i = 0; i < selected.length; i++) {
    const { seat, car } = selected[i];
    let name = prompt(`Passenger ${i+1} name (for seat ${seat}):`, `Passenger ${i+1}`);
    if (!name) name = `Passenger ${i+1}`;
    passengers.push({ name, seat, car });
  }
  
  // Calculate fare
  let fareResult = null;
  if (currentBooking.journey.stopovers === 0) {
    fareResult = calculateSingleLegFare(
      currentBooking.journey.legs[0].from.stationId,
      currentBooking.journey.legs[0].to.stationId,
      currentBooking.serviceType,
      currentBooking.travelClass.charAt(0).toUpperCase() + currentBooking.travelClass.slice(1)
    );
  } else {
    fareResult = calculateTransferFare(currentBooking.journey, 
      currentBooking.travelClass.charAt(0).toUpperCase() + currentBooking.travelClass.slice(1));
  }
  if (!fareResult) { alert('Fare calculation error'); return; }
  const totalFare = fareResult.fare * currentBooking.passengerCount;
  
  // Show fare confirmation
  const summaryHtml = `
    <h3>Confirm your purchase</h3>
    <p><strong>Train:</strong> ${currentBooking.trainId} (${currentBooking.serviceType})<br>
    <strong>Route:</strong> ${currentBooking.fromName} → ${currentBooking.toName}<br>
    <strong>Date:</strong> ${currentBooking.selectedDate} at ${currentBooking.departureTime}<br>
    <strong>Class:</strong> ${currentBooking.travelClass}<br>
    <strong>Passengers:</strong> ${currentBooking.passengerCount}</p>
    <p><strong>Seats:</strong><br>${passengers.map(p => `${p.name} – Car ${p.car}, Seat ${p.seat}`).join('<br>')}</p>
    <p><strong>Fare per passenger:</strong> ${fareResult.fare} DSD<br>
    <strong>Total fare:</strong> ${totalFare} DSD</p>
    <p style="color: #e67e22;">Your current balance: ${currentUser.balance} DSD</p>
    <div class="form-actions">
      <button id="finalConfirmBtn" class="primary">Confirm & Pay</button>
      <button id="finalCancelBtn" class="secondary">Go back</button>
    </div>
  `;
  
  document.getElementById('seatSelectionPanel').innerHTML = summaryHtml;
  
  document.getElementById('finalConfirmBtn').onclick = () => {
    if (currentUser.balance < totalFare) {
      alert(`Insufficient balance. You have ${currentUser.balance} DSD, need ${totalFare} DSD. Please top up.`);
      return;
    }
    
    // Deduct and create booking
    currentUser.balance -= totalFare;
    currentUser.totalTrips = (currentUser.totalTrips || 0) + 1;
    currentUser.totalSpent = (currentUser.totalSpent || 0) + totalFare;
    
    const booking = {
      id: Date.now(),
      trainId: currentBooking.trainId,
      serviceType: currentBooking.serviceType,
      from: currentBooking.fromName,
      to: currentBooking.toName,
      departureTime: currentBooking.departureTime,
      date: currentBooking.selectedDate,
      travelClass: currentBooking.travelClass,
      passengers: passengers,
      totalFare: totalFare,
      bookedAt: new Date().toISOString()
    };
    
    const success = await createBooking(booking);
    if (!success) {
      alert('Failed to create booking. Please try again.');
      return;
    }
    
    let summary = `<h3>Booking confirmed!</h3>`;
    summary += `<p><strong>Booking reference:</strong> #${booking.id}<br>
                <strong>Train:</strong> ${booking.trainId}<br>
                <strong>Route:</strong> ${booking.from} → ${booking.to}<br>
                <strong>Date:</strong> ${booking.date} at ${booking.departureTime}<br>
                <strong>Class:</strong> ${booking.travelClass}<br>
                <strong>Total paid:</strong> ${booking.totalFare} DSD</p>`;
    summary += `<h4>Passengers & seats</h4><ul>`;
    booking.passengers.forEach(p => {
      summary += `<li>${p.name} – Car ${p.car}, Seat ${p.seat}</li>`;
    });
    summary += `</ul><p>A confirmation email has been sent (simulated).</p>`;
    document.getElementById('bookingSummary').innerHTML = summary;
    
    showTemporaryMessage(`Booking successful! ${totalFare} DSD deducted.`, 'success');
    showStep(3);
  };
  
  document.getElementById('finalCancelBtn').onclick = () => {
    // Go back to seat map
    showSeatSelection();
  };
}

// Replace confirmBooking with this version (shows fare summary before final payment)
function confirmBooking() {
  const checked = document.querySelectorAll('.seat-checkbox:checked');
  if (checked.length !== currentBooking.passengerCount) {
    alert(`Please select exactly ${currentBooking.passengerCount} seat(s).`);
    return;
  }
  
  // Build passenger list (ask for names)
  const passengers = [];
  for (let i = 0; i < checked.length; i++) {
    const cb = checked[i];
    const seatName = cb.dataset.seatname;
    const car = cb.dataset.car;
    let name = prompt(`Passenger ${i+1} name (for seat ${seatName}):`, `Passenger ${i+1}`);
    if (!name) name = `Passenger ${i+1}`;
    passengers.push({ name, seat: seatName, car });
  }
  
  // Calculate fare
  let fareResult = null;
  if (currentBooking.journey.stopovers === 0) {
    fareResult = calculateSingleLegFare(
      currentBooking.journey.legs[0].from.stationId,
      currentBooking.journey.legs[0].to.stationId,
      currentBooking.serviceType,
      currentBooking.travelClass.charAt(0).toUpperCase() + currentBooking.travelClass.slice(1)
    );
  } else {
    fareResult = calculateTransferFare(currentBooking.journey, 
      currentBooking.travelClass.charAt(0).toUpperCase() + currentBooking.travelClass.slice(1));
  }
  if (!fareResult) { alert('Fare calculation error'); return; }
  const totalFare = fareResult.fare * currentBooking.passengerCount;
  
  // Show fare confirmation step
  const summaryHtml = `
    <h3>Confirm your purchase</h3>
    <p><strong>Train:</strong> ${currentBooking.trainId} (${currentBooking.serviceType})<br>
    <strong>Route:</strong> ${currentBooking.fromName} → ${currentBooking.toName}<br>
    <strong>Date:</strong> ${currentBooking.selectedDate} at ${currentBooking.departureTime}<br>
    <strong>Class:</strong> ${currentBooking.travelClass}<br>
    <strong>Passengers:</strong> ${currentBooking.passengerCount}</p>
    <p><strong>Seats:</strong><br>${passengers.map(p => `${p.name} – Car ${p.car}, Seat ${p.seat}`).join('<br>')}</p>
    <p><strong>Fare per passenger:</strong> ${fareResult.fare} DSD<br>
    <strong>Total fare:</strong> ${totalFare} DSD</p>
    <p style="color: #e67e22;">Your current balance: ${currentUser.balance} DSD</p>
    <div class="form-actions">
      <button id="confirmPayBtn" class="primary">Confirm & Pay</button>
      <button id="cancelPayBtn" class="secondary">Go back</button>
    </div>
  `;
  
  // Show confirmation inside step2 or a new step
  const seatPanel = document.getElementById('seatSelectionPanel');
  seatPanel.innerHTML = summaryHtml;
  
  document.getElementById('confirmPayBtn').onclick = () => {
    // Check balance again
    if (currentUser.balance < totalFare) {
      alert(`Insufficient balance. You have ${currentUser.balance} DSD, need ${totalFare} DSD. Please top up.`);
      return;
    }
    
    // Deduct balance and create booking record
    currentUser.balance -= totalFare;
    currentUser.totalTrips = (currentUser.totalTrips || 0) + 1;
    currentUser.totalSpent = (currentUser.totalSpent || 0) + totalFare;
    
    const booking = {
      id: Date.now(),
      trainId: currentBooking.trainId,
      serviceType: currentBooking.serviceType,
      from: currentBooking.fromName,
      to: currentBooking.toName,
      departureTime: currentBooking.departureTime,
      date: currentBooking.selectedDate,
      travelClass: currentBooking.travelClass,
      passengers: passengers,
      totalFare: totalFare,
      bookedAt: new Date().toISOString()
    };
    
    if (!currentUser.bookings) currentUser.bookings = [];
    currentUser.bookings.unshift(booking);
    window.userData[currentUser.username].bookings = currentUser.bookings;
    window.userData[currentUser.username].balance = currentUser.balance;
    window.userData[currentUser.username].totalTrips = currentUser.totalTrips;
    window.userData[currentUser.username].totalSpent = currentUser.totalSpent;
    saveUserData();
    updateUserUI();
    
    // Show confirmation
    let summary = `<h3>Booking confirmed!</h3>`;
    summary += `<p><strong>Booking reference:</strong> #${booking.id}<br>
                <strong>Train:</strong> ${booking.trainId}<br>
                <strong>Route:</strong> ${booking.from} → ${booking.to}<br>
                <strong>Date:</strong> ${booking.date} at ${booking.departureTime}<br>
                <strong>Class:</strong> ${booking.travelClass}<br>
                <strong>Total paid:</strong> ${booking.totalFare} DSD</p>`;
    summary += `<h4>Passengers & seats</h4><ul>`;
    booking.passengers.forEach(p => {
      summary += `<li>${p.name} – Car ${p.car}, Seat ${p.seat}</li>`;
    });
    summary += `</ul><p>A confirmation email has been sent (simulated).</p>`;
    document.getElementById('bookingSummary').innerHTML = summary;
    
    showTemporaryMessage(`Booking successful! ${totalFare} DSD deducted.`, 'success');
    showStep(3);
  };
  
  document.getElementById('cancelPayBtn').onclick = () => {
    // Go back to seat selection
    showSeatSelection();
  };
}

// Initialize user system when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (timetableData) {
      initUserSystem();
    } else {
      const checkDataInterval = setInterval(() => {
        if (timetableData) {
          clearInterval(checkDataInterval);
          initUserSystem();
        }
      }, 500);
    }
  }, 1200);
});

function createUserAuthModal() {
  // Check if modal already exists
  if (document.getElementById('userAuthModal')) {
    return; // Don't recreate if it already exists
  }
  
  const modalHtml = `
    <div id="userAuthModal" class="modal hidden" style="display: none;">
      <div class="modal-content">
        <span class="modal-close" id="modalCloseBtn">&times;</span>
        
        <div id="userLoginForm">
          <h3>Login to Shore Connect</h3>
          <div id="userLoginError" style="color: #e74c3c; display: none; background: rgba(231,76,60,0.1); padding: 8px; border-radius: 4px; margin-bottom: 12px;"></div>
          <input type="text" id="userLoginId" placeholder="Username or Email" class="search-input" style="width: 100%; margin-bottom: 12px;">
          <input type="password" id="userLoginPassword" placeholder="Password" class="search-input" style="width: 100%; margin-bottom: 12px;">
          <button id="userLoginBtn" class="primary" style="width: 100%;">Login</button>
          <p style="margin-top: 16px; text-align: center;"><a href="#" id="showRegisterLink" style="color: #ff9800;">Don't have an account? Register</a></p>
        </div>
        
        <div id="userRegisterForm" style="display: none;">
          <h3>Register New Account</h3>
          <div id="regError" style="color: #e74c3c; display: none; background: rgba(231,76,60,0.1); padding: 8px; border-radius: 4px; margin-bottom: 12px;"></div>
          <div id="regSuccess" style="color: #27ae60; display: none; background: rgba(39,174,96,0.1); padding: 8px; border-radius: 4px; margin-bottom: 12px;"></div>
          <input type="text" id="regUsername" placeholder="Username (min 3 chars)" class="search-input" style="width: 100%; margin-bottom: 12px;">
          <input type="email" id="regEmail" placeholder="Email" class="search-input" style="width: 100%; margin-bottom: 12px;">
          <input type="password" id="regPassword" placeholder="Password (min 6 chars)" class="search-input" style="width: 100%; margin-bottom: 12px;">
          <input type="password" id="regConfirmPassword" placeholder="Confirm Password" class="search-input" style="width: 100%; margin-bottom: 12px;">
          <select id="regDefaultClass" class="search-input" style="width: 100%; margin-bottom: 12px;">
            <option value="Third">Third Class (Default)</option>
            <option value="Second">Second Class</option>
            <option value="First">First Class</option>
          </select>
          <button id="userRegisterBtn" class="primary" style="width: 100%; margin-bottom: 8px;">Register</button>
          <button id="regCancelBtn" class="secondary" style="width: 100%;">Back to Login</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  
  // Add CSS for modal if not present
  if (!document.getElementById('modalStyles')) {
    const style = document.createElement('style');
    style.id = 'modalStyles';
    style.textContent = `
      .modal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(74, 63, 107, 0.8);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
      }
      .modal.hidden {
        display: none !important;
      }
      .modal:not(.hidden) {
        display: flex !important;
      }
      .modal-content {
        background: linear-gradient(135deg, #faf8fc 0%, #f0ebf5 100%);
        padding: 24px;
        border-radius: 12px;
        min-width: 320px;
        max-width: 400px;
        position: relative;
        border: 2px solid #b8a9c9;
      }
      .modal-close {
        position: absolute;
        top: 12px;
        right: 16px;
        font-size: 24px;
        cursor: pointer;
        color: #8b7fa8;
      }
      .modal-close:hover {
        color: #e74c3c;
      }
      @keyframes slideIn {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      @keyframes slideOut {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(100%);
          opacity: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  // Attach event listeners
  setupModalEventListeners();
}

function setupModalEventListeners() {
  const modal = document.getElementById('userAuthModal');
  const closeBtn = document.getElementById('modalCloseBtn');
  const userLoginBtn = document.getElementById('userLoginBtn');
  const userRegisterBtn = document.getElementById('userRegisterBtn');
  const regCancelBtn = document.getElementById('regCancelBtn');
  const showRegisterLink = document.getElementById('showRegisterLink');
  const userCancelBtn = document.getElementById('userCancelBtn');
  
  // Close when clicking X
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideUserAuth();
    };
  }
  
  // Close when clicking outside modal
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) {
        hideUserAuth();
      }
    };
  }
  
  if (userLoginBtn) {
    userLoginBtn.onclick = (e) => {
      e.preventDefault();
      userLogin();
    };
  }
  
  if (userCancelBtn) {
    userCancelBtn.onclick = (e) => {
      e.preventDefault();
      hideUserAuth();
    };
  }
  
  if (userRegisterBtn) {
    userRegisterBtn.onclick = (e) => {
      e.preventDefault();
      userRegister();
    };
  }
  
  if (regCancelBtn) {
    regCancelBtn.onclick = (e) => {
      e.preventDefault();
      showLoginForm();
    };
  }
  
  if (showRegisterLink) {
    showRegisterLink.onclick = (e) => {
      e.preventDefault();
      showRegisterForm();
    };
  }
  
  // Handle Enter key press on login password field
  const passwordField = document.getElementById('userLoginPassword');
  if (passwordField) {
    passwordField.onkeypress = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        userLogin();
      }
    };
  }
}
