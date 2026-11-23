"use strict";

/* ============================================================
   Colo Colo · versión web
   Datos: API pública de ESPN (sin clave, no oficial). Misma lógica
   que ESPNClient.swift / HomeRepository.swift de la app iOS.
   ============================================================ */

const TEAM_ID = "2688";
const SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer";

const COMP = {
  liga: { slug: "chi.1", name: "Liga de Primera" },
  copa: { slug: "chi.copa_chi", name: "Copa Chile" },
  libertadores: { slug: "conmebol.libertadores", name: "Copa Libertadores" },
  sudamericana: { slug: "conmebol.sudamericana", name: "Copa Sudamericana" },
};
const LOCAL = [COMP.liga, COMP.copa];
const INTERNATIONAL = [COMP.libertadores, COMP.sudamericana];

const CACHE_KEY = "colocolo-home-v1";
const LIVE_POLL_MS = 30_000;
const LIVE_WINDOW_BEFORE = 15 * 60_000;
const LIVE_WINDOW_AFTER = 150 * 60_000;

/* ---------------- Red ---------------- */

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const soft = (p) => p.catch(() => null);

async function schedule(comp, { fixtures = false, season } = {}) {
  const q = [];
  if (fixtures) q.push("fixture=true");
  if (season) q.push(`season=${season}`);
  const url = `${SITE}/${comp.slug}/teams/${TEAM_ID}/schedule${q.length ? "?" + q.join("&") : ""}`;
  const raw = await getJSON(url);
  return (raw.events || []).map((e) => parseMatch(e, comp)).filter(Boolean);
}

async function standingsTable(comp) {
  const root = await getJSON(`${STANDINGS}/${comp.slug}/standings`);
  let groups = (root.children || []).map((c) => ({ name: c.name, entries: c.standings?.entries || [] }));
  if (!groups.length && root.standings?.entries) groups = [{ name: null, entries: root.standings.entries }];
  return groups.map((g) => ({
    name: groups.length > 1 ? (g.name || "").replace("Group", "Grupo") : null,
    rows: g.entries.map(parseEntry).sort((a, b) => a.rank - b.rank),
  }));
}

/* ---------------- Conversión ---------------- */

function scoreOf(c) {
  const s = c.score;
  if (s == null) return null;
  if (typeof s === "object") {
    if (s.value != null) return Math.round(s.value);
    const n = parseInt(s.displayValue, 10);
    return Number.isNaN(n) ? null : n;
  }
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function side(c) {
  const id = c.team?.id || c.id || "";
  return {
    id,
    name: c.team?.shortDisplayName || c.team?.displayName || "Por definir",
    abbr: c.team?.abbreviation || "",
    score: scoreOf(c),
    logo: id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${id}.png` : "",
  };
}

const ROUND_ES = {
  "Regular Season": "", "Group Stage": "Fase de grupos", "Round of 32": "Dieciseisavos de final",
  "Round of 16": "Octavos de final", "Quarterfinals": "Cuartos de final", "Quarter-finals": "Cuartos de final",
  "Semifinals": "Semifinal", "Semi-finals": "Semifinal", "Final": "Final",
  "Knockout Round Playoffs": "Playoffs", "Preliminary Round": "Fase previa",
  "First Stage": "Primera fase", "Second Stage": "Segunda fase", "Third Stage": "Tercera fase",
};
function roundName(name, leg) {
  if (!name) return null;
  // ESPN usa el nombre de la temporada ("2026 Primera División de Chile") como fase regular.
  if (/^\d{4} /.test(name)) name = "Regular Season";
  const t = name in ROUND_ES ? ROUND_ES[name] : name;
  const parts = t ? [t] : [];
  if (leg === "1st Leg") parts.push("ida");
  if (leg === "2nd Leg") parts.push("vuelta");
  return parts.length ? parts.join(", ") : null;
}

function parseMatch(raw, comp) {
  const c = raw.competitions?.[0];
  const cs = c?.competitors;
  if (!c || !cs || cs.length !== 2) return null;
  const date = new Date(c.date || raw.date);
  if (Number.isNaN(date.getTime())) return null;
  const homeRaw = cs.find((x) => x.homeAway === "home") || cs[0];
  const awayRaw = cs.find((x) => x.homeAway === "away") || cs[1];
  return {
    id: raw.id,
    date: date.toISOString(),
    timeConfirmed: c.timeValid ?? raw.timeValid ?? true,
    comp: comp.slug,
    compName: comp.name,
    round: roundName(raw.seasonType?.name, c.leg?.displayValue),
    home: side(homeRaw),
    away: side(awayRaw),
    venue: c.venue?.fullName || null,
    city: c.venue?.address?.city || null,
    tv: (c.broadcasts || []).flatMap((b) => b.names || []),
    state: c.status?.type?.state || "pre",
    completed: !!c.status?.type?.completed,
  };
}

function parseEntry(e) {
  const stat = (n) => Math.round(e.stats?.find((s) => s.name === n)?.value ?? 0);
  const id = e.team?.id || "";
  return {
    id,
    name: e.team?.shortDisplayName || e.team?.displayName || "",
    logo: `https://a.espncdn.com/i/teamlogos/soccer/500/${id}.png`,
    rank: stat("rank"), points: stat("points"), played: stat("gamesPlayed"),
    wins: stat("wins"), draws: stat("ties"), losses: stat("losses"),
    gd: stat("pointDifferential"), gf: stat("pointsFor"), ga: stat("pointsAgainst"),
  };
}

/* ---------------- Ayudantes de partido ---------------- */

const isHome = (m) => m.home.id === TEAM_ID;
const us = (m) => (isHome(m) ? m.home : m.away);
const rival = (m) => (isHome(m) ? m.away : m.home);
const when = (m) => new Date(m.date);

function outcome(m) {
  const a = us(m).score, b = rival(m).score;
  if (!m.completed || a == null || b == null) return null;
  return a > b ? "w" : a === b ? "d" : "l";
}

/** Igual que en iOS: cuenta como próximo si no terminó y no empezó hace más de 3 horas. */
function isUpcoming(m, now) {
  return !m.completed && m.state !== "post" && when(m).getTime() > now - 3 * 3600_000;
}

function inLiveWindow(m, now) {
  if (m.state === "in") return true;
  if (m.completed || m.state === "post") return false;
  const t = when(m).getTime();
  return now >= t - LIVE_WINDOW_BEFORE && now <= t + LIVE_WINDOW_AFTER;
}

/* ---------------- Carga principal ---------------- */

async function loadHome() {
  const now = Date.now();
  const year = new Date().getFullYear();

  const [ligaPlayed, copaPlayed, ligaNext, copaNext, table, cup] = await Promise.all([
    soft(schedule(COMP.liga)),
    soft(schedule(COMP.copa)),
    soft(schedule(COMP.liga, { fixtures: true })),
    soft(schedule(COMP.copa, { fixtures: true })),
    soft(standingsTable(COMP.liga)),
    soft(cupStatus(year, now)),
  ]);

  if ([ligaPlayed, copaPlayed, ligaNext, copaNext].every((x) => x == null)) {
    throw new Error("No se pudo conectar con ESPN");
  }

  let played = [...(ligaPlayed || []), ...(copaPlayed || [])].filter((m) => m.completed);
  if (played.length < 3) {
    // A comienzo de temporada se completa con la anterior.
    const prev = await Promise.all(LOCAL.map((c) => soft(schedule(c, { season: year - 1 }))));
    const known = new Set(played.map((m) => m.id));
    played = played.concat(prev.flat().filter((m) => m && m.completed && !known.has(m.id)));
  }
  played.sort((a, b) => when(b) - when(a));

  const playedIds = new Set(played.map((m) => m.id));
  const seen = new Set();
  const upcoming = [...(ligaNext || []), ...(copaNext || [])]
    .filter((m) => isUpcoming(m, now) && !playedIds.has(m.id) && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => when(a) - when(b));

  const next = upcoming[0] || null;
  let nextInfo = null;
  if (next) nextInfo = await soft(matchSummary(next));

  return {
    next,
    nextInfo,
    upcoming,
    lastResults: played.slice(0, 3),
    table: table?.[0]?.rows || [],
    cup,
    updatedAt: new Date().toISOString(),
  };
}

/** Revisa Libertadores y Sudamericana del año en curso. Devuelve null si no juega ninguna. */
async function cupStatus(year, now) {
  for (const comp of INTERNATIONAL) {
    const [playedRaw, nextRaw] = await Promise.all([
      soft(schedule(comp)),
      soft(schedule(comp, { fixtures: true })),
    ]);
    const inYear = (m) => when(m).getFullYear() === year;
    const played = (playedRaw || []).filter((m) => m.completed && inYear(m));
    const next = (nextRaw || []).filter((m) => isUpcoming(m, now) && inYear(m));
    if (!played.length && !next.length) continue;

    const last = played.sort((a, b) => when(b) - when(a))[0] || null;
    const nxt = next.sort((a, b) => when(a) - when(b))[0] || null;
    let group = null;
    const groups = await soft(standingsTable(comp));
    for (const g of groups || []) {
      const row = g.rows.find((r) => r.id === TEAM_ID);
      if (row) { group = { ...row, groupName: g.name, total: g.rows.length }; break; }
    }
    return { name: comp.name, stage: (nxt || last)?.round || null, group, last, next: nxt };
  }
  return null;
}

/** Detalles extra del partido (árbitro, marcador en vivo, goles). */
async function matchSummary(m) {
  const s = await getJSON(`${SITE}/${m.comp}/summary?event=${m.id}`);
  const comp = s.header?.competitions?.[0];
  const status = comp?.status || {};
  const scores = {};
  for (const c of comp?.competitors || []) scores[c.id || c.team?.id] = scoreOf(c);
  const goals = (s.keyEvents || [])
    .filter((e) => e.scoringPlay)
    .map((e) => ({
      minute: e.clock?.displayValue || "",
      teamId: e.team?.id,
      player: e.participants?.[0]?.athlete?.displayName || "",
      own: /own goal/i.test(e.type?.text || e.text || ""),
      pen: /penalty/i.test(e.type?.text || e.text || ""),
    }));
  return {
    referee: s.gameInfo?.officials?.[0]?.displayName || null,
    attendance: s.gameInfo?.attendance || null,
    state: status.type?.state || m.state,
    completed: !!status.type?.completed,
    clock: status.displayClock || null,
    detail: status.type?.shortDetail || status.type?.detail || null,
    scores,
    goals,
  };
}

/* ---------------- Formato ---------------- */

const fmtDay = new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("es-CL", { weekday: "short", day: "numeric", month: "short" });
const fmtTime = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit" });
const fmtStamp = new Intl.DateTimeFormat("es-CL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

function relative(date) {
  const ms = date - Date.now();
  const mins = Math.round(ms / 60_000);
  if (Math.abs(mins) < 60) return rtf.format(mins, "minute");
  const hours = Math.round(ms / 3600_000);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(new Date())) / 86_400_000);
  return rtf.format(days, "day");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

/* ---------------- Render: Inicio ---------------- */

const $home = document.getElementById("tab-home");
const $table = document.getElementById("tab-table");
const $status = document.getElementById("status");
let current = null;
let liveTimer = null;

function teamBlock(t) {
  return `<div class="team"><img src="${esc(t.logo)}" alt="" loading="lazy"><span>${esc(t.name)}</span></div>`;
}

function nextMatchCard(m, info) {
  if (!m) return `<article class="card"><h2>Próximo partido</h2><p class="empty">No hay partidos programados por ahora.</p></article>`;
  const d = when(m);
  const live = info && info.state === "in";
  const liveish = live || inLiveWindow(m, Date.now());
  const hs = info?.scores?.[m.home.id], as = info?.scores?.[m.away.id];
  const center = live && hs != null && as != null
    ? `<div class="score">${hs} – ${as}</div>`
    : `<div class="vs">VS</div>`;

  const rows = [
    ["Competencia", [m.compName, m.round].filter(Boolean).join(" · ")],
    ["Condición", isHome(m) ? "Local" : "Visita"],
    m.venue && ["Estadio", m.venue],
    m.city && ["Ciudad", m.city],
    info?.referee && ["Árbitro", info.referee],
    m.tv.length && ["TV", m.tv.join(", ")],
  ].filter(Boolean);

  const goals = live && info.goals.length
    ? `<ul class="goals">${info.goals.map((g) => `<li><span class="min">${esc(g.minute)}</span><span>${esc(g.player)}${g.pen ? " (penal)" : ""}${g.own ? " (autogol)" : ""} · ${esc(g.teamId === m.home.id ? m.home.abbr || m.home.name : m.away.abbr || m.away.name)}</span></li>`).join("")}</ul>`
    : "";

  return `<article class="card" id="next-card">
    <h2><span>${live ? "En vivo" : "Próximo partido"}</span>${live ? `<span class="badge"><span class="dot"></span>En vivo</span>` : ""}</h2>
    <div class="match-head">${teamBlock(m.home)}${center}${teamBlock(m.away)}</div>
    ${live
      ? `<div class="live-clock">${esc(info.clock || info.detail || "")}</div>${goals}`
      : `<div class="when">
          <div class="date">${esc(fmtDay.format(d))}</div>
          <div class="countdown">${m.timeConfirmed ? `${fmtTime.format(d)} h · ${esc(relative(d))}` : `Hora por confirmar · ${esc(relative(d))}`}</div>
        </div>`}
    <ul class="details">${rows.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join("")}</ul>
    ${!live && m.timeConfirmed ? `<button class="btn" data-ics="${esc(m.id)}">Agregar al calendario (con alertas)</button>` : ""}
    ${!live && !m.timeConfirmed ? `<p class="sub" style="margin:12px 0 0">El botón de calendario aparece cuando ESPN confirme la hora.</p>` : ""}
    ${liveish && !live ? `<p class="sub" style="margin:12px 0 0;text-align:center">El marcador en vivo aparece aquí cuando empiece el partido.</p>` : ""}
  </article>`;
}

function standingCard(table) {
  const me = table.find((r) => r.id === TEAM_ID);
  if (!me) return `<article class="card"><h2>Liga de Primera</h2><p class="empty">Tabla no disponible.</p></article>`;
  return `<article class="card">
    <h2><span>Liga de Primera</span><button class="link-btn" data-goto="table">Ver tabla</button></h2>
    <div class="stats">
      <div class="stat"><div class="num">${me.rank}°</div><div class="lbl">de ${table.length}</div></div>
      <div class="stat"><div class="num">${me.points}</div><div class="lbl">puntos</div></div>
      <div class="stat"><div class="num">${signed(me.gd)}</div><div class="lbl">dif. de gol</div></div>
    </div>
    <div class="record">${me.played} PJ · ${me.wins} G · ${me.draws} E · ${me.losses} P</div>
    ${raceSentence(table)}
  </article>`;
}

function cupCard(cup) {
  if (!cup) return "";
  const rows = [
    cup.stage && ["Fase", cup.stage],
    cup.group && [cup.group.groupName || "Grupo", `${cup.group.rank}° de ${cup.group.total} · ${cup.group.points} pts`],
    cup.last && ["Último", `${resultLine(cup.last)}`],
    cup.next && ["Próximo", `${rival(cup.next).name} · ${fmtShort.format(when(cup.next))}`],
  ].filter(Boolean);
  return `<article class="card"><h2>${esc(cup.name)}</h2>
    <ul class="details" style="margin:0;border-top:0">${rows.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join("")}</ul>
  </article>`;
}

function resultLine(m) {
  return `${m.home.abbr || m.home.name} ${m.home.score ?? "-"}–${m.away.score ?? "-"} ${m.away.abbr || m.away.name}`;
}

function resultsCard(list) {
  if (!list.length) return `<article class="card"><h2>Últimos resultados</h2><p class="empty">Sin resultados.</p></article>`;
  const letter = { w: "G", d: "E", l: "P" };
  return `<article class="card"><h2>Últimos resultados</h2><ul class="results">${list.map((m) => {
    const o = outcome(m) || "d";
    return `<li>
      <span class="pill ${o}">${letter[o]}</span>
      <div><div class="rival">${isHome(m) ? "vs" : "en"} ${esc(rival(m).name)}</div>
        <div class="meta">${esc(fmtShort.format(when(m)))} · ${esc(m.compName)}</div></div>
      <span class="res">${us(m).score ?? "-"}–${rival(m).score ?? "-"}</span>
    </li>`;
  }).join("")}</ul></article>`;
}

function upcomingCard(list) {
  const rest = list.slice(1, 6);
  if (!rest.length) return "";
  const hasIcs = list.some((m) => m.timeConfirmed);
  return `<article class="card"><h2>Siguientes partidos</h2><ul class="upcoming">${rest.map((m) => `<li>
      <div><div style="font-weight:600">${isHome(m) ? "vs" : "en"} ${esc(rival(m).name)}</div>
      <div class="sub">${esc(fmtShort.format(when(m)))}${m.timeConfirmed ? " · " + fmtTime.format(when(m)) : " · hora por confirmar"} · ${esc(m.compName)}</div></div>
      ${m.timeConfirmed ? `<button class="link-btn" data-ics="${esc(m.id)}">+ Calendario</button>` : ""}
    </li>`).join("")}</ul>
    ${hasIcs ? `<button class="btn secondary" data-ics="all">Agregar todos al calendario</button>` : ""}
  </article>`;
}

function renderHome(data) {
  $home.innerHTML = [
    nextMatchCard(data.next, data.nextInfo),
    standingCard(data.table),
    cupCard(data.cup),
    resultsCard(data.lastResults),
    upcomingCard(data.upcoming),
  ].join("");
}

/* ---------------- Render: Tabla y carrera por el título ---------------- */

/** Liga de Primera: todos contra todos, ida y vuelta → 2 × (equipos − 1) fechas. */
function raceData(table) {
  if (!table.length) return null;
  const total = 2 * (table.length - 1);
  const rows = table.map((r) => {
    const left = Math.max(0, total - r.played);
    return { ...r, left, max: r.points + 3 * left };
  });
  const leader = rows[0];
  const me = rows.find((r) => r.id === TEAM_ID);
  return { total, rows, leader, me };
}

function raceSentence(table) {
  const race = raceData(table);
  if (!race || !race.me) return "";
  const { rows, me, leader } = race;
  const others = rows.filter((r) => r.id !== TEAM_ID);
  const bestRivalMax = Math.max(...others.map((r) => r.max));
  let text;
  if (me.left === 0 && others.every((r) => r.left === 0)) {
    text = me.rank === 1 ? `<strong>Colo Colo terminó primero.</strong>` : `Torneo terminado: Colo Colo ${me.rank}°.`;
  } else if (me.points > bestRivalMax) {
    text = `<strong>¡Colo Colo es campeón!</strong> Nadie lo puede alcanzar.`;
  } else if (me.id === leader.id) {
    const second = rows[1];
    const need = bestRivalMax - me.points + 1;
    text = `Lidera por <strong>${me.points - second.points} pts</strong> sobre ${esc(second.name)} con ${me.left} partido${me.left === 1 ? "" : "s"} por jugar.`;
    if (need <= 3 * me.left) text += ` Le faltan <strong>${need} pts</strong> para asegurar el título sin depender de nadie.`;
  } else if (me.max < leader.points) {
    text = `Sin opción matemática al título: está a ${leader.points - me.points} pts de ${esc(leader.name)}.`;
  } else {
    text = `A <strong>${leader.points - me.points} pts</strong> de ${esc(leader.name)} con ${me.left} partido${me.left === 1 ? "" : "s"} por jugar (${3 * me.left} pts en juego).`;
  }
  return `<p class="race-note" style="margin:12px 0 0;text-align:center">${text}</p>`;
}

function renderTable(table) {
  const race = raceData(table);
  if (!race) { $table.innerHTML = `<article class="card"><p class="empty">Tabla no disponible.</p></article>`; return; }
  const { rows, leader, me } = race;
  const contenders = rows.filter((r) => r.max >= leader.points);
  const ref = me || leader;

  const raceCard = `<article class="card"><h2>Carrera por el título</h2>
    ${raceSentence(table).replace('style="margin:12px 0 0;text-align:center"', "")}
    <div class="table-wrap"><table>
      <thead><tr><th class="team-cell">Equipo</th><th>Pts</th><th>Quedan</th><th>Máx.</th><th>vs CC</th></tr></thead>
      <tbody>${contenders.map((r) => {
        const diff = r.points - ref.points;
        return `<tr class="${r.id === TEAM_ID ? "me" : ""}">
          <td class="team-cell"><img src="${esc(r.logo)}" alt="" loading="lazy"><span>${esc(r.name)}</span></td>
          <td class="pts">${r.points}</td><td>${r.left}</td><td>${r.max}</td>
          <td class="${r.id === TEAM_ID ? "" : diff > 0 ? "gap-neg" : "gap-pos"}">${r.id === TEAM_ID ? "—" : signed(diff)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    <p class="sub" style="margin:10px 0 0">Equipos que todavía pueden alcanzar al líder. "Máx." = puntos si ganan todo lo que les queda (${race.total} fechas en total).</p>
  </article>`;

  const fullCard = `<article class="card"><h2>Liga de Primera</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th class="team-cell">Equipo</th><th>PJ</th><th class="hide-sm">G</th><th class="hide-sm">E</th><th class="hide-sm">P</th><th>DG</th><th>Pts</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.id === TEAM_ID ? "me" : ""}">
        <td>${r.rank}</td>
        <td class="team-cell"><img src="${esc(r.logo)}" alt="" loading="lazy"><span>${esc(r.name)}</span></td>
        <td>${r.played}</td><td class="hide-sm">${r.wins}</td><td class="hide-sm">${r.draws}</td><td class="hide-sm">${r.losses}</td>
        <td>${signed(r.gd)}</td><td class="pts">${r.points}</td>
      </tr>`).join("")}</tbody>
    </table></div>
  </article>`;

  $table.innerHTML = raceCard + fullCard;
}

/* ---------------- Calendario (.ics con alarmas) ---------------- */

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

function icsEvent(m) {
  const start = when(m);
  const end = new Date(start.getTime() + 2 * 3600_000);
  const title = `${m.home.name} vs ${m.away.name}`;
  const alarm = (trigger, desc) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(desc)}`, `TRIGGER:${trigger}`, "END:VALARM"];
  return [
    "BEGIN:VEVENT",
    `UID:${m.id}@colo-colo-web`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText("⚽ " + title)}`,
    `LOCATION:${icsText([m.venue, m.city].filter(Boolean).join(", "))}`,
    `DESCRIPTION:${icsText([m.compName, m.round].filter(Boolean).join(" · "))}`,
    ...alarm("-P2D", `${title}: en 2 días`),
    ...alarm("-P1D", `${title}: mañana`),
    ...alarm("-PT15M", `${title}: en 15 minutos`),
    "END:VEVENT",
  ];
}

function downloadICS(matches) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//colo-colo-web//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    ...matches.flatMap(icsEvent), "END:VCALENDAR"];
  const ics = lines.join("\r\n");
  const name = matches.length === 1 ? `colo-colo-${matches[0].id}.ics` : "colo-colo-partidos.ics";
  const a = document.createElement("a");
  a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
  // En iPhone, abrir el .ics directamente muestra "Agregar al calendario".
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iOS) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------- En vivo ---------------- */

function scheduleLive() {
  clearTimeout(liveTimer);
  const m = current?.next;
  if (!m || !inLiveWindow(m, Date.now())) return;
  liveTimer = setTimeout(async () => {
    try {
      const info = await matchSummary(m);
      current.nextInfo = info;
      if (info.completed || info.state === "post") {
        await refresh(); // terminó: recarga todo (resultados, tabla, próximo)
        return;
      }
      const card = document.getElementById("next-card");
      if (card) card.outerHTML = nextMatchCard(m, info);
      setStatus(current.updatedAt, info.state === "in");
    } catch { /* se reintenta en el siguiente ciclo */ }
    scheduleLive();
  }, LIVE_POLL_MS);
}

/* ---------------- Estado, caché y eventos ---------------- */

function setStatus(updatedAt, live = false, error = null) {
  $status.className = "status" + (error ? " error" : "");
  const base = updatedAt ? `Actualizado ${fmtStamp.format(new Date(updatedAt))}` : "";
  $status.textContent = [error, base, live ? "Marcador en vivo cada 30 s" : "", "Datos: ESPN"].filter(Boolean).join(" · ");
}

function render(data) {
  current = data;
  renderHome(data);
  renderTable(data.table);
  setStatus(data.updatedAt, data.nextInfo?.state === "in");
}

let loading = false;
async function refresh() {
  if (loading) return;
  loading = true;
  const btn = document.getElementById("refresh");
  btn.classList.add("spinning");
  try {
    const data = await loadHome();
    render(data);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* sin almacenamiento */ }
  } catch (e) {
    if (!current) {
      $home.innerHTML = `<article class="card"><p class="empty">No se pudieron cargar los datos. Revisa tu conexión y toca el botón de actualizar.</p></article>`;
    }
    setStatus(current?.updatedAt, false, "Sin conexión con ESPN");
  } finally {
    loading = false;
    btn.classList.remove("spinning");
    scheduleLive();
  }
}

function selectTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $home.hidden = name !== "home";
  $table.hidden = name !== "table";
  window.scrollTo({ top: 0 });
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) return selectTab(tab.dataset.tab);
  const go = e.target.closest("[data-goto]");
  if (go) return selectTab(go.dataset.goto);
  const ics = e.target.closest("[data-ics]");
  if (ics && current) {
    const id = ics.dataset.ics;
    const list = id === "all" ? current.upcoming.filter((m) => m.timeConfirmed) : current.upcoming.filter((m) => m.id === id);
    if (list.length) downloadICS(list);
  }
});
document.getElementById("refresh").addEventListener("click", refresh);

// Al volver a la app (desde segundo plano) se refresca si pasaron más de 5 minutos.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const age = current ? Date.now() - new Date(current.updatedAt).getTime() : Infinity;
  if (age > 5 * 60_000) refresh(); else scheduleLive();
});

(function start() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached) render(cached);
  } catch { /* caché inválido */ }
  if (!current) $home.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
  refresh();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
