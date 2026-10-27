(function(){
    if (window.__vk_inject_loaded) return;
    window.__vk_inject_loaded = true;
    const TAG = '[VK-EXPORT-INJECT]';

    function post(type, payload){
        try { window.postMessage({__vk_export:true, type, payload}, '*'); } catch(e){}
    }
    function log(msg, obj){
        post('log', {msg, obj: obj ? String(obj).slice(0,400) : null});
        try { console.log(TAG, msg, obj || ''); } catch(e){}
    }
    function emit(items){
        if (!Array.isArray(items)) return;
        post('messages', items);
        log('captured items', {count: items.length, first_id: items[0] && (items[0].id || items[0].cmid)});
    }

    // ---- XHR ----
    const OrigXHR = window.XMLHttpRequest;
    function WrappedXHR(){
        const xhr = new OrigXHR();
        const origOpen = xhr.open;
        xhr.open = function(method, url){
            this.__vk_url = String(url || '');
            this.__vk_method = method;
            return origOpen.apply(this, arguments);
        };
        const origSend = xhr.send;
        xhr.send = function(body){
            const self = this;
            this.addEventListener('load', function(){
                try {
                    const url = self.__vk_url || '';
                    if (!/vk|api|al_im|im\b/i.test(url)) return;
                    log('XHR', (self.__vk_method || 'GET') + ' ' + url.slice(0, 200));
                    const ct = self.getResponseHeader('content-type') || '';
                    if (!/json/i.test(ct)) return;
                    const text = self.responseText;
                    if (!text || text.length < 2) return;
                    handleResponse(url, JSON.parse(text));
                } catch(e){ log('XHR parse error', e && e.message); }
            });
            return origSend.apply(this, arguments);
        };
        return xhr;
    }
    WrappedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = WrappedXHR;

    // ---- fetch ----
    const origFetch = window.fetch;
    window.fetch = async function(...args){
        const url = (args[0] instanceof Request ? args[0].url : (typeof args[0] === 'string' ? args[0] : ''));
        const resp = await origFetch.apply(this, args);
        try {
            if (/vk|api|al_im|im\b/i.test(url)) {
                log('FETCH', url.slice(0, 200));
                const clone = resp.clone();
                const ct = clone.headers.get('content-type') || '';
                if (/json/i.test(ct)) {
                    const text = await clone.text();
                    if (text && text.length > 1) handleResponse(url, JSON.parse(text));
                }
            }
        } catch(e){}
        return resp;
    };

    // ---- Разбор ответов ----
    function handleResponse(url, data){
        if (!data || typeof data !== 'object') return;
        let found = 0;
        const tryItems = (arr) => { if (Array.isArray(arr) && arr.length){ emit(arr); found += arr.length; } };

        if (data.response){
            if (Array.isArray(data.response.items)) tryItems(data.response.items);
            else if (Array.isArray(data.response.messages)) tryItems(data.response.messages);
            else if (data.response.history && Array.isArray(data.response.history)) tryItems(data.response.history);
            else if (Array.isArray(data.response)) {
                data.response.forEach(r => {
                    if (r && Array.isArray(r.items)) tryItems(r.items);
                    if (r && Array.isArray(r.messages)) tryItems(r.messages);
                    if (r && r.history && Array.isArray(r.history)) tryItems(r.history);
                });
            }
        }
        // al_im.php часто возвращает массив верхнего уровня
        if (!found && Array.isArray(data)){
            data.forEach(d => {
                if (d && Array.isArray(d.items)) tryItems(d.items);
                if (d && Array.isArray(d.messages)) tryItems(d.messages);
                if (d && d.response && Array.isArray(d.response.items)) tryItems(d.response.items);
            });
        }
        if (!found && data.items && Array.isArray(data.items)) tryItems(data.items);

        if (!found && url && /messages|history|al_im|im\b/i.test(url)){
            log('JSON without items', {url: url.slice(0,120), keys: Object.keys(data).join(',')});
        }
    }

    log('inject.js loaded', location.href);
})();