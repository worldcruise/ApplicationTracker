// Public, non-privileged diagnostic response only. No pairing, capture, storage,
// filesystem access, native messages, or user/candidate data is exposed here.
chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  try {
    const url = new URL(sender.url);
    if (sender.id || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
        || !["/", "/extension-studio"].includes(url.pathname)
        || sender.origin && sender.origin !== url.origin) return false;
    if (!message || message.type !== "tracker:diagnostics" || message.protocolVersion !== 1
        || typeof message.nonce !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(message.nonce)
        || Object.keys(message).some(key => !["type", "protocolVersion", "nonce"].includes(key))) return false;
    respond({ protocolVersion: 1, nonce: message.nonce, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
  } catch { /* Untrusted senders and malformed messages get no response. */ }
  return false;
});
