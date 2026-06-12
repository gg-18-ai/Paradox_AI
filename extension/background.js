chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting panel behavior:", error));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "openSidePanel",
    title: "Open Paradox AI Side Panel",
    contexts: ["all"]
  });
  console.log("Paradox AI extension installed.");
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "openSidePanel") {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Best-effort programmatic opening on tab updates/creations
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && !tab.url.startsWith("chrome://")) {
    try {
      await chrome.sidePanel.open({ tabId: tabId });
    } catch (e) {
      console.log("Could not auto-open side panel (requires user gesture):", e.message);
    }
  }
});
