(function(){
'use strict';

// ---------- CONFIG ----------
const XPATH_CONTAINER = '//*[@id="composer-textarea"]/div/div/div[4]';
const RECORD_BUTTON_ID = 'btn-audio-record';
const TIMER_ID = 'btn-audio-timer';

// ---------- estado ----------
let mediaRecorder = null;
let audioChunks = [];
let recording = false;
let timerInterval = null;
let seconds = 0;

// ---------- helpers ----------
function formatSeconds(s){ return String(s % 60).padStart(2,'0'); }

// ---------- estilo do botão ----------
const style = document.createElement('style');
style.innerHTML = `
#${RECORD_BUTTON_ID} {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background-color: #155EEF;
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    border: none;
    position: relative;
    transition: background-color 0.2s, transform 0.08s;
    font-size: 12px;
    color: white;
}
#${RECORD_BUTTON_ID}.recording {
    background-color: red;
}
#${RECORD_BUTTON_ID} #${TIMER_ID} {
    position: absolute;
    font-family: monospace;
    font-size: 10px;
    color: white;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
}
`;
document.head.appendChild(style);

// ---------- criar botão ----------
function createButtonElement(){
    const btn = document.createElement('button');
    btn.id = RECORD_BUTTON_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label','Gravar áudio');
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="white" width="16" height="16">
            <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2z"></path>
        </svg>
        <div id="${TIMER_ID}">0</div>
    `;
    return btn;
}

// ---------- contagem e animação ----------
function startVisualRecording(btn){
    recording = true;
    seconds = 0;
    btn.classList.add('recording');
    const timerEl = btn.querySelector('#' + TIMER_ID);
    if(timerEl) timerEl.textContent = '0';
    timerInterval = setInterval(()=>{
        seconds++;
        if(timerEl) timerEl.textContent = seconds;
    }, 1000);
}

function stopVisualRecording(btn){
    recording = false;
    clearInterval(timerInterval);
    btn.classList.remove('recording');
    const timerEl = btn.querySelector('#' + TIMER_ID);
    if(timerEl) timerEl.textContent = '0';
}

// ---------- extrair IDs ----------
function extractIdsFromPath(){
    const parts = window.location.pathname.split('/').filter(Boolean);
    const locationIdx = parts.indexOf('location');
    const LOCATION_ID = locationIdx >= 0 && parts.length > locationIdx + 1 ? parts[locationIdx + 1] : null;
    const convIdx = parts.lastIndexOf('conversations');
    const CONVERSATION_ID = convIdx >= 0 && parts.length > convIdx + 1 ? parts[convIdx + 1] : null;
    return { LOCATION_ID, CONVERSATION_ID };
}

// ---------- buscar contactId ----------
async function fetchContactId(conversationId, PIT_TOKEN){
    try {
        const res = await fetch(`https://services.leadconnectorhq.com/conversations/${encodeURIComponent(conversationId)}/messages`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${PIT_TOKEN}`, Version: '2021-07-28' }
        });
        if(!res.ok) return null;
        const data = await res.json();
        if(!data.messages || !data.messages.messages || data.messages.messages.length === 0) return null;
        for(const msg of data.messages.messages){
            if(msg && msg.contactId) return msg.contactId;
        }
        return null;
    } catch(err){ console.error('Erro ao buscar contactId:', err); return null; }
}

// ---------- converter WebM -> MP3 ----------
async function convertWebMtoMP3(webmBlob){
    const arrayBuffer = await webmBlob.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const mono = new Int16Array(audioBuffer.length);
    const numChannels = audioBuffer.numberOfChannels;
    for(let i=0;i<audioBuffer.length;i++){
        let sum=0;
        for(let ch=0;ch<numChannels;ch++) sum += audioBuffer.getChannelData(ch)[i] || 0;
        const avg=sum/numChannels;
        mono[i]=avg<0 ? Math.round(avg*0x8000) : Math.round(avg*0x7FFF);
    }
    const mp3encoder = new lamejs.Mp3Encoder(1,audioBuffer.sampleRate,128);
    const sampleBlockSize=1152;
    const mp3Data=[];
    for(let i=0;i<mono.length;i+=sampleBlockSize){
        const slice = mono.subarray(i,i+sampleBlockSize);
        const buf = mp3encoder.encodeBuffer(slice);
        if(buf.length>0) mp3Data.push(buf);
    }
    const flush = mp3encoder.flush();
    if(flush.length>0) mp3Data.push(flush);
    audioCtx.close();
    const combined = mp3Data.reduce((acc,cur)=>{
        const tmp=new Uint8Array(acc.length+cur.length);
        tmp.set(acc,0);
        tmp.set(cur,acc.length);
        return tmp;
    }, new Uint8Array());
    return new Blob([combined.buffer], { type:'audio/mpeg' });
}

// ---------- upload MP3 ----------
async function uploadMp3AndGetUrl(mp3Blob, PIT_TOKEN, LOCATION_ID, contactId, conversationId){
    const form=new FormData();
    form.append('uploadedFiles',mp3Blob,'audio.mp3');
    if(LOCATION_ID) form.append('locationId',LOCATION_ID);
    if(contactId) form.append('contactId',contactId);
    if(conversationId) form.append('conversationId',conversationId);
    const res = await fetch('https://services.leadconnectorhq.com/conversations/messages/upload',{
        method:'POST',
        headers:{ Authorization:`Bearer ${PIT_TOKEN}`, Version:'2021-07-28' },
        body: form
    });
    if(!res.ok){ const txt=await res.text().catch(()=>null); throw new Error('Upload falhou: '+res.status+' '+txt); }
    const data = await res.json();
    if(data && data.uploadedFiles){
        const keys = Object.keys(data.uploadedFiles);
        if(keys.length>0) return data.uploadedFiles[keys[0]];
    }
    throw new Error('Resposta do upload não contém URL do arquivo.');
}

// ---------- enviar mensagem ----------
async function sendMessageWithAttachment(contactId, uploadedFileUrl, PIT_TOKEN){
    const body={
        type:'SMS',
        contactId:contactId,
        body:'📎 Áudio enviado',
        attachments:[uploadedFileUrl]
    };
    const res = await fetch('https://services.leadconnectorhq.com/conversations/messages',{
        method:'POST',
        headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${PIT_TOKEN}`, Version:'2021-07-28' },
        body: JSON.stringify(body)
    });
    if(!res.ok){ const txt=await res.text().catch(()=>null); throw new Error('Falha ao enviar mensagem: '+res.status+' '+txt); }
    return await res.json().catch(()=>null);
}

// ---------- gravação e envio ----------
async function startRecordingFlow(btn,PIT_TOKEN){
    try{
        const stream = await navigator.mediaDevices.getUserMedia({audio:true});
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = e=>{ if(e.data && e.data.size) audioChunks.push(e.data); }
        mediaRecorder.onstop = async ()=>{
            stopVisualRecording(btn);
            try{
                const webmBlob = new Blob(audioChunks,{type:'audio/webm'});
                const mp3Blob = await convertWebMtoMP3(webmBlob);
                const { LOCATION_ID, CONVERSATION_ID } = extractIdsFromPath();
                if(!CONVERSATION_ID){ stream.getTracks().forEach(t=>t.stop()); return; }
                const contactId = await fetchContactId(CONVERSATION_ID, PIT_TOKEN);
                if(!contactId){ stream.getTracks().forEach(t=>t.stop()); return; }
                const uploadedUrl = await uploadMp3AndGetUrl(mp3Blob, PIT_TOKEN, LOCATION_ID, contactId, CONVERSATION_ID);
                await sendMessageWithAttachment(contactId, uploadedUrl, PIT_TOKEN);
            }catch(err){ console.error('Erro durante envio:', err); }
            finally{ stream.getTracks().forEach(t=>t.stop()); }
        };
        mediaRecorder.start();
        startVisualRecording(btn);
    }catch(err){ console.error('Erro ao acessar microfone:', err); stopVisualRecording(btn); }
}

// ---------- inserir botão ----------
function insertButton(){
    if(!window.location.href.includes('location/EJoBWKAGbBtYNTMkbLXD')){
        const existingBtn = document.getElementById(RECORD_BUTTON_ID);
        if(existingBtn) existingBtn.remove();
        return;
    }

    const targetElement = document.evaluate(XPATH_CONTAINER,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
    if(!targetElement) return;
    if(document.getElementById(RECORD_BUTTON_ID)) return;

    const btn = createButtonElement();
    targetElement.appendChild(btn);
    btn.addEventListener('click', ev=>{
        ev.preventDefault(); ev.stopPropagation();
        const PIT_TOKEN = 'pit-d99a1f2a-0b59-42ef-95b7-ec0ef2260940';
        if(!recording) startRecordingFlow(btn,PIT_TOKEN);
        else if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    });
}

// ---------- observar DOM ----------
const observer = new MutationObserver(()=>insertButton());
observer.observe(document.body,{childList:true,subtree:true});
insertButton();

})();
