import { loadSession, request } from "./client.js";
import { awaitPresence } from "./presence-gate.js";

const memberSearch = document.querySelector("#member-search");
const memberPrefix = document.querySelector("#member-prefix");
const memberResults = document.querySelector("#member-results");
const memberStatus = document.querySelector("#member-status");
const activeMembers = document.querySelector("#active-members");
const activeMembersStatus = document.querySelector("#active-members-status");

function renderMemberLink(member) {
  const username = typeof member === "string" ? member : member.username;
  const link = document.createElement("a");
  link.className = "member-result";
  link.href = `/profile?username=${encodeURIComponent(username)}`;
  link.textContent = username;
  return link;
}

async function searchMembers(prefix) {
  memberStatus.textContent = "Searching...";
  const result = await request(`/api/profiles?prefix=${encodeURIComponent(prefix)}`);
  memberResults.replaceChildren(...result.usernames.map(renderMemberLink));
  memberStatus.textContent = result.usernames.length === 0 ? "No matching members." : "";
}

async function loadMemberSearch() {
  const query = new URLSearchParams(location.search).get("q")?.trim() ?? "";
  memberPrefix.value = query;
  if (!query) {
    memberResults.replaceChildren();
    memberStatus.textContent = "Search by the beginning of a username.";
    return;
  }
  await searchMembers(query);
}

async function loadActiveMembers() {
  if (!activeMembers || !activeMembersStatus) return;
  activeMembersStatus.textContent = "Loading active members...";
  const result = await request("/api/members/active");
  activeMembers.replaceChildren(...result.members.map(renderMemberLink));
  activeMembersStatus.textContent = result.members.length === 0
    ? "No members active right now."
    : "";
}

memberSearch.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = memberPrefix.value.trim();
  if (!query) return;
  const button = memberSearch.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await searchMembers(query);
    history.replaceState(null, "", `/members?q=${encodeURIComponent(query)}`);
  } catch {
    memberStatus.textContent = "Could not search members.";
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("rw:routechange", () => {
  if (location.pathname !== "/members") return;
  Promise.all([
    loadActiveMembers().catch(() => {
      activeMembersStatus.textContent = "Could not load active members.";
    }),
    loadMemberSearch().catch(() => {
      memberStatus.textContent = "Could not search members.";
    }),
  ]);
});

async function init() {
  await awaitPresence();
  try {
    await loadSession();
  } catch {
    location.assign("/account#sign-in");
    return;
  }
  await Promise.all([
    loadActiveMembers().catch(() => {
      activeMembersStatus.textContent = "Could not load active members.";
    }),
    loadMemberSearch().catch(() => {
      memberStatus.textContent = "Could not search members.";
    }),
  ]);
}

init();
