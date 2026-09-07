import { loadSession, request } from "./client.js";
import { awaitPresence } from "./presence-gate.js";
import { createStochasticRefreshScheduler } from "./stochastic-refresh.js";

const memberSearch = document.querySelector("#member-search");
const memberPrefix = document.querySelector("#member-prefix");
const memberResults = document.querySelector("#member-results");
const memberStatus = document.querySelector("#member-status");
const memberMore = document.querySelector("#members-more");
const activeMembers = document.querySelector("#active-members");
const activeMembersStatus = document.querySelector("#active-members-status");
let searchVersion = 0;
let nextOffset = 0;
let currentQuery = "";

function renderMemberLink(member) {
  const link = document.createElement("a");
  link.className = "member-result";
  link.href = `/profile?username=${encodeURIComponent(member.username)}`;
  link.textContent = member.username;
  return link;
}

async function searchMembers(query, append = false) {
  const version = ++searchVersion;
  if (!append) {
    currentQuery = query;
    nextOffset = 0;
    memberResults.replaceChildren();
    memberMore.hidden = true;
  }
  memberMore.disabled = true;
  memberStatus.textContent = "Loading members...";
  try {
    const params = new URLSearchParams({ q: query, limit: "50", offset: String(nextOffset) });
    const result = await request(`/api/members?${params}`);
    if (version !== searchVersion) return;
    memberResults.append(...result.members.map(renderMemberLink));
    nextOffset = result.nextOffset;
    memberMore.hidden = !result.hasMore;
    memberStatus.textContent = nextOffset === 0
      ? (query ? "No matching members." : "No current members.")
      : `${nextOffset} member${nextOffset === 1 ? "" : "s"} shown${result.hasMore ? "; more available" : ""}.`;
  } catch {
    if (version === searchVersion) memberStatus.textContent = "Could not load members. Try again.";
  } finally {
    if (version === searchVersion) memberMore.disabled = false;
  }
}

function loadMemberSearch() {
  const query = new URLSearchParams(location.search).get("q")?.trim() ?? "";
  memberPrefix.value = query;
  return searchMembers(query);
}

async function loadActiveMembers() {
  try {
    const result = await request("/api/members/active");
    activeMembers.replaceChildren(...result.members.map(renderMemberLink));
    activeMembersStatus.textContent = result.members.length === 0
      ? "No members active right now."
      : (result.members.length === 50 ? "Showing the 50 most recently active members." : "");
  } catch {
    activeMembersStatus.textContent = "Could not refresh active members. Retrying automatically.";
  }
}

memberSearch.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = memberPrefix.value.trim();
  history.replaceState(history.state, "", query ? `/members?q=${encodeURIComponent(query)}` : "/members");
  searchMembers(query);
});
memberPrefix.addEventListener("input", () => {
  if (!memberPrefix.value) {
    history.replaceState(history.state, "", "/members");
    searchMembers("");
  }
});
memberMore.addEventListener("click", () => searchMembers(currentQuery, true));

const refresh = createStochasticRefreshScheduler({
  attempt: loadActiveMembers,
  isActive: () => location.pathname === "/members" && document.visibilityState === "visible",
  minimumDelayMs: 30_000,
  maximumDelayMs: 60_000,
});
window.addEventListener("rw:routechange", () => {
  if (location.pathname !== "/members") return;
  loadActiveMembers();
  loadMemberSearch();
});
document.addEventListener("visibilitychange", () => {
  if (location.pathname === "/members" && document.visibilityState === "visible") {
    loadActiveMembers();
    refresh.reschedule();
  }
});

async function init() {
  await awaitPresence();
  try {
    await loadSession();
  } catch {
    location.assign("/account#sign-in");
    return;
  }
  await Promise.all([loadActiveMembers(), loadMemberSearch()]);
  refresh.start();
}

init();
