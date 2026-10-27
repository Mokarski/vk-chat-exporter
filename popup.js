let collectedMessages = [];
let lastDebugText = '';

const $ = (id) => document.getElementById(id);

function setDebug(parts){
    const lines = [];
    for (const p of parts){
        lines.push('=== FRAME ' + p.frameId + ' :: ' + (p.url || '') + ' ===');
        lines.push('messages: ' + ((p.resp && p.resp.messages) ? p.resp.messages.length : 0));
        if (p.resp && Array.isArray(p.resp.log)){
            p.resp.log.forEach(e => lines.push('  [' + new Date(e.t).toLocaleTimeString() + '] ' + e.msg + (e.obj ? ' | ' + e.obj : '')));
        }
        lines.push('');
    }
    lastDebugText = lines.join('\n');
    $('debug').value = lastDebugText;
}

async function allFrames(tabId){
    try {
        const frames = await chrome.webNavigation.getAllFrames({tabId});
        return frames || [];
    } catch(e) { return []; }
}

async function sendToFrame(tabId, frameId, action){
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {action}, {frameId}, (resp) => {
            if (chrome.runtime.lastError){ resolve(null); return; }
            resolve(resp);
        });
    });
}

function isRealMessage(m){
    return m && typeof m === 'object' && m.peer_id && m.conversation_message_id && m.date;
}

// "2000000073, c73, e75" -> [2000000073, 2000000073, 2000000075]; пусто -> null
function parsePeerIds(str){
    if (!str || !str.trim()) return null;
    const parts = str.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const ids = [];
    for (const p of parts){
        let v = p;
        if (/^[ce]\d+$/i.test(v)) v = String(2000000000 + parseInt(v.slice(1), 10));
        const n = parseInt(v, 10);
        if (!isNaN(n)) ids.push(n);
    }
    return ids.length ? ids : null;
}

// Достаёт peer_id из URL активной вкладки (vk.com/im?sel=...)
async function detectPeerFromTab(){
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab || !tab.url) return null;
    const m = tab.url.match(/[?&]sel=([^&]+)/);
    if (!m) return null;
    const sel = decodeURIComponent(m[1]);
    if (/^[ce]\d+$/i.test(sel)) return String(2000000000 + parseInt(sel.slice(1), 10));
    if (/^\d+$/.test(sel)) return sel;
    return null;
}

async function collectFromAllFrames(){
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab){ return { messages: [], parts: [], rawCount: 0, peerStats: {}, wantedPeerIds: null }; }
    const wantedPeerIds = parsePeerIds($('peerId').value);
    const frames = await allFrames(tab.id);
    const parts = [];
    const merged = [];
    const seen = new Set();
    let rawCount = 0;

    for (const f of frames){
        const resp = await sendToFrame(tab.id, f.frameId, 'getMessages');
        if (!resp) continue;
        parts.push({ frameId: f.frameId, url: f.url, resp });
        (resp.messages || []).forEach(m => {
            rawCount++;
            const id = m.id || m.cmid || m.conversation_message_id;
            if (id && !seen.has(id)){ seen.add(id); merged.push(m); }
        });
    }

    const real = merged.filter(isRealMessage);
    const peerStats = {};
    real.forEach(m => { peerStats[m.peer_id] = (peerStats[m.peer_id] || 0) + 1; });

    const filtered = wantedPeerIds ? real.filter(m => wantedPeerIds.includes(m.peer_id)) : real;
    return { messages: filtered, parts, rawCount, peerStats, wantedPeerIds };
}

function generateMarkdown(messages){
    const sorted = [...messages].sort((a,b) => (a.date || 0) - (b.date || 0));
    const peerSet = new Set(sorted.map(m => m.peer_id));
    const showPeer = peerSet.size > 1;

    let md = '# VK Chat Export\n\n';
    md += 'Total messages: ' + sorted.length + '\n';
    md += 'peer_ids: ' + [...peerSet].join(', ') + '\n';
    md += 'Exported: ' + new Date().toISOString() + '\n\n---\n\n';

    for (const msg of sorted){
        const date = msg.date ? new Date(msg.date * 1000).toLocaleString() : 'unknown date';
        const author = msg.from_id != null ? msg.from_id : 'unknown';
        const peerTag = showPeer ? ' [' + msg.peer_id + ']' : '';

        if (msg.action){
            md += '*Service' + peerTag + ': ' + msg.action.type + '*';
            if (msg.action.member_id) md += ' (member_id: ' + msg.action.member_id + ')';
            if (msg.action.text) md += ' — ' + msg.action.text;
            md += '\n\n';
            continue;
        }

        md += '**' + author + '**' + peerTag + ' (' + date + '):\n';
        if (msg.text) md += msg.text + '\n';

        if (Array.isArray(msg.attachments) && msg.attachments.length){
            md += 'Attachments:\n';
            for (const att of msg.attachments){
                let url = null, desc = att.type;
                if (att.type === 'photo' && att.photo && att.photo.sizes){
                    const best = att.photo.sizes.reduce((a,b) => (a.width*a.height > b.width*b.height) ? a : b);
                    url = best.url; desc = 'Photo';
                } else if (att.type === 'doc' && att.doc){
                    url = att.doc.url; desc = 'Doc: ' + (att.doc.title || att.doc.id);
                } else if (att.type === 'audio' && att.audio){
                    url = att.audio.url; desc = 'Audio: ' + (att.audio.artist || '') + ' — ' + (att.audio.title || '');
                } else if (att.type === 'video' && att.video){
                    url = att.video.player || att.video.direct_url || null;
                    desc = 'Video: ' + (att.video.title || att.video.id);
                } else if (att.type === 'link' && att.link){
                    url = att.link.url; desc = 'Link: ' + (att.link.title || att.link.url);
                } else if (att.type === 'sticker'){
                    desc = 'Sticker';
                }
                md += url ? '- [' + desc + '](' + url + ')\n' : '- ' + desc + '\n';
            }
        }
        md += '\n---\n\n';
    }
    return md;
}

function fileSuffix(){
    const ids = [...new Set(collectedMessages.map(m => m.peer_id))];
    if (ids.length === 1) return '_' + ids[0];
    if (ids.length > 1) return '_multi';
    return '';
}

$('btnDetectPeer').addEventListener('click', async () => {
    const id = await detectPeerFromTab();
    if (id){ $('peerId').value = id; $('status').textContent = 'Определён peer_id: ' + id; }
    else { $('status').textContent = 'Не удалось определить peer_id из URL. Введите вручную (peer_id или c73).'; }
});

$('btnCollect').addEventListener('click', async () => {
    $('status').textContent = 'Опрос всех фреймов...';
    const { messages, parts, rawCount, peerStats, wantedPeerIds } = await collectFromAllFrames();
    collectedMessages = messages;
    setDebug(parts);

    const totalReal = Object.values(peerStats).reduce((a,b) => a+b, 0);
    const peersLine = Object.entries(peerStats)
        .sort((a,b) => b[1]-a[1])
        .map(([id, cnt]) => id + ': ' + cnt)
        .join(', ') || '—';

    if (parts.length === 0){
        $('status').textContent = 'Ни один фрейм не ответил. Content script не внедрён — перезагрузите страницу ВК.';
    } else {
        const filterInfo = wantedPeerIds ? 'фильтр [' + wantedPeerIds.join(',') + ']' : 'без фильтра';
        $('status').textContent = 'Собрано: ' + messages.length + ' (' + filterInfo + '). ' +
            'Реальных в буфере: ' + totalReal + ' → ' + peersLine + '. ' +
            'Отфильтровано прочего: ' + (rawCount - totalReal) + '.';
    }
});

$('btnDownloadJson').addEventListener('click', () => {
    if (!collectedMessages.length){ $('status').textContent = 'Сначала нажмите «Собрать».'; return; }
    const blob = new Blob([JSON.stringify(collectedMessages, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'vk_chat' + fileSuffix() + '.json', saveAs: true });
    $('status').textContent = 'JSON отправлен на скачивание.';
});

$('btnDownloadMarkdown').addEventListener('click', () => {
    if (!collectedMessages.length){ $('status').textContent = 'Сначала нажмите «Собрать».'; return; }
    const md = generateMarkdown(collectedMessages);
    const blob = new Blob([md], {type: 'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'vk_chat' + fileSuffix() + '.md', saveAs: true });
    $('status').textContent = 'Markdown отправлен на скачивание.';
});

$('btnDownloadAtt').addEventListener('click', () => {
    if (!collectedMessages.length){ $('status').textContent = 'Сначала нажмите «Собрать».'; return; }
    let count = 0;
    collectedMessages.forEach(msg => {
        (msg.attachments || []).forEach(att => {
            let url = null, filename = null;
            if (att.type === 'photo' && att.photo && att.photo.sizes){
                const best = att.photo.sizes.reduce((a,b) => (a.width*a.height > b.width*b.height) ? a : b);
                url = best.url; filename = 'photo_' + att.photo.id + '.jpg';
            } else if (att.type === 'doc' && att.doc){
                url = att.doc.url; filename = att.doc.title || ('doc_' + att.doc.id);
            } else if (att.type === 'audio' && att.audio){
                url = att.audio.url; filename = 'audio_' + att.audio.id + '.mp3';
            } else if (att.type === 'video' && att.video && att.video.files){
                url = att.video.files.mp4_240 || att.video.files.mp4_360 || att.video.files.mp4_480;
                filename = 'video_' + att.video.id + '.mp4';
            }
            if (url && filename){
                chrome.downloads.download({ url, filename: 'vk_attachments/' + filename, saveAs: false });
                count++;
            }
        });
    });
    $('status').textContent = 'Запущено скачивание вложений: ' + count;
});

$('btnClear').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab) return;
    const frames = await allFrames(tab.id);
    for (const f of frames) await sendToFrame(tab.id, f.frameId, 'clearBuffer');
    collectedMessages = [];
    $('debug').value = '';
    $('status').textContent = 'Буфер очищен во всех фреймах.';
});

$('btnCopyDebug').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastDebugText || $('debug').value); $('status').textContent = 'Отладка скопирована.'; }
    catch(e){ $('debug').select(); document.execCommand('copy'); $('status').textContent = 'Отладка скопирована (execCommand).'; }
});