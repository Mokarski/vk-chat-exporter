(function(){
    if (window.__vk_content_loaded) return;
    window.__vk_content_loaded = true;

    // 1) Внедряем inject.js в MAIN world
    try {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('inject.js');
        s.onload = () => s.remove();
        (document.head || document.documentElement).appendChild(s);
    } catch(e) { console.error('inject failed', e); }

    // 2) Собираем данные от inject.js
    const logArr = [];
    const messagesArr = [];
    const seen = new Set();
    const MAX_LOG = 300;

    addLog('content.js loaded: ' + location.href);

    function addLog(msg, obj){
        logArr.push({t: Date.now(), msg, obj});
        if (logArr.length > MAX_LOG) logArr.shift();
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || !d.__vk_export) return;
        if (d.type === 'log') addLog(d.payload.msg, d.payload.obj);
        else if (d.type === 'messages' && Array.isArray(d.payload)) {
            let added = 0;
            d.payload.forEach(m => {
                const id = m.id || m.cmid || m.conversation_message_id;
                if (id && !seen.has(id)) { seen.add(id); messagesArr.push(m); added++; }
            });
            if (added) addLog('buffer +' + added + ' (total ' + messagesArr.length + ')');
        }
    });

    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
        if (req.action === 'getMessages') {
            sendResponse({ messages: messagesArr, log: logArr, url: location.href, isTop: window === window.top });
        } else if (req.action === 'clearBuffer') {
            messagesArr.length = 0; logArr.length = 0; seen.clear();
            addLog('buffer cleared: ' + location.href);
            sendResponse({ok: true});
        } else if (req.action === 'ping') {
            sendResponse({ok: true, url: location.href});
        }
        return true;
    });
})();