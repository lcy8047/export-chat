/* Only a deliberate toolbar click grants access to the active tab. */
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const url = new URL(tab.url || "");
    if (!tab.id || url.protocol !== "https:" || url.hostname !== "chatgpt.com") {
      throw new Error("ChatGPT 대화 탭에서 확장프로그램을 실행하세요.");
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["format.js", "collector.js", "panel.js"]
    });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Chat Export · 현재 대화 저장" });
  } catch (error) {
    if (!tab.id) return;
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#a43b32" });
    await chrome.action.setTitle({ tabId: tab.id, title: String(error.message || error) });
  }
});
