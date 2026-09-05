const status = document.getElementById("runtimeStatus");
const result = document.getElementById("result");
const analyzeButton = document.getElementById("analyzeButton");
const openButton = document.getElementById("openButton");

function show(message, kind = "") {
  result.textContent = message;
  result.className = `result ${kind}`.trim();
}

async function send(request) {
  const response = await messenger.runtime.sendMessage(request);
  if (!response?.ok) throw new Error(response?.error || "CIVION Mail runtime did not respond.");
  return response;
}

async function openCenter() {
  try {
    await send({ type: "openActionCenter" });
  } catch {
    await messenger.tabs.create({ url: messenger.runtime.getURL("action-center/index.html") });
  }
}

async function getDisplayedMessageIds() {
  try {
    const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !messenger.messageDisplay?.getDisplayedMessages) return [];
    const messages = await messenger.messageDisplay.getDisplayedMessages(tab.id);
    return Array.isArray(messages) ? messages.map((message) => message.id).filter((id) => id !== undefined) : [];
  } catch {
    return [];
  }
}

async function analyzeCurrentSelection() {
  const displayedIds = await getDisplayedMessageIds();
  if (displayedIds.length) return send({ type: "analyzeMessageIds", messageIds: displayedIds });
  return send({ type: "analyzeSelected" });
}

async function checkRuntime() {
  try {
    const response = await send({ type: "getState" });
    const active = response.listenerState?.newMail === true;
    status.textContent = active ? `ACTIVE · v${response.version}` : `ERROR · v${response.version}`;
    status.dataset.state = active ? "active" : "error";
  } catch (error) {
    status.textContent = "RUNTIME NOT RESPONDING";
    status.dataset.state = "error";
    show(error.message, "error");
  }
}

analyzeButton.addEventListener("click", async () => {
  analyzeButton.disabled = true;
  show("Analyzing…");
  try {
    const response = await analyzeCurrentSelection();
    show(`Analyzed messages: ${response.handled ?? 0}.`, "success");
    await openCenter();
    window.close();
  } catch (error) {
    show(error.message, "error");
  } finally {
    analyzeButton.disabled = false;
  }
});

openButton.addEventListener("click", async () => {
  openButton.disabled = true;
  try {
    await openCenter();
    window.close();
  } catch (error) {
    show(error.message, "error");
    openButton.disabled = false;
  }
});

void checkRuntime();
