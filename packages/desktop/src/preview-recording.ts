import { randomUUID } from "node:crypto";
import { BrowserWindow, type WebContents } from "electron";

/** Capture only this owned guest. The encoder has no preload, Node, network or ORC session. */
export class PreviewRecording {
  private encoder: BrowserWindow | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline = 0;
  private stopped = false;
  private failure: Error | null = null;
  private pending: Promise<void> = Promise.resolve();
  get running(): boolean {
    return !!this.encoder && !this.stopped;
  }
  private async bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.cancel();
            reject(new Error("Browser recording timed out; start a new recording"));
          }, 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async start(guest: WebContents, seconds: number, ended: () => void): Promise<void> {
    if (this.encoder) throw new Error("Stop the current recording first");
    const encoder = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: `orc-recording-${randomUUID()}`,
      },
    });
    this.encoder = encoder;
    encoder.webContents.session.setPermissionRequestHandler((_web, _permission, reply) =>
      reply(false),
    );
    encoder.webContents.session.setPermissionCheckHandler(() => false);
    encoder.webContents.session.webRequest.onBeforeRequest((details, reply) =>
      reply({ cancel: !details.url.startsWith("data:") }),
    );
    encoder.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const nonce = randomUUID();
    await this.bounded(
      encoder.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; img-src data:; media-src blob:"><canvas></canvas><script nonce="${nonce}">
      const canvas=document.querySelector('canvas');canvas.width=1280;canvas.height=720;
      const context=canvas.getContext('2d');const stream=canvas.captureStream(0);
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:1200000});
      let chunks=[],bytes=0,overflow=false;
      recorder.ondataavailable=event=>{bytes+=event.data.size;if(bytes>16000000){overflow=true;chunks=[];if(recorder.state!=='inactive')recorder.stop();}else if(!overflow)chunks.push(event.data);};
      globalThis.paint=async src=>{if(recorder.state==='inactive')return;const image=new Image();image.src=src;await image.decode();context.fillStyle='#fff';context.fillRect(0,0,1280,720);const scale=Math.min(1280/image.width,720/image.height);context.drawImage(image,0,0,image.width*scale,image.height*scale);stream.getVideoTracks()[0].requestFrame();};
      globalThis.finish=()=>new Promise((resolve,reject)=>{const done=()=>{stream.getTracks().forEach(track=>track.stop());if(overflow){reject(new Error('Recording exceeded 16 MB; use a shorter duration'));return;}const reader=new FileReader();reader.onload=()=>resolve({type:'recording',mimeType:'video/webm',name:'browser-recording.webm',data:reader.result.split(',')[1]});reader.onerror=()=>reject(new Error('Recording encoding failed'));reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));};if(recorder.state==='inactive')done();else{recorder.onstop=done;recorder.stop();}});
      recorder.start(1000);
    </script>`)}`,
      ),
    );
    this.deadline = Date.now() + seconds * 1000;
    const tick = async () => {
      if (this.stopped || this.encoder !== encoder) return;
      try {
        if (guest.isDestroyed()) throw new Error("Recorded browser tab closed");
        const image = await this.bounded(guest.capturePage());
        const frame = (image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image).toJPEG(
          65,
        );
        await this.bounded(
          encoder.webContents.executeJavaScript(
            `globalThis.paint(${JSON.stringify(`data:image/jpeg;base64,${frame.toString("base64")}`)})`,
          ),
        );
      } catch {
        this.failure = new Error("Browser recording was interrupted; start a new recording");
        this.stopped = true;
      }
      if (Date.now() >= this.deadline) {
        this.stopped = true;
        try {
          await this.bounded(
            encoder.webContents.executeJavaScript("globalThis.finish().then(()=>true)"),
          );
        } catch {
          this.failure = new Error("Recording could not finish; start a new recording");
        }
      }
      if (this.stopped) ended();
      else
        this.timer = setTimeout(() => {
          this.pending = tick();
        }, 150);
    };
    this.pending = tick();
    await this.pending;
    if (this.failure) throw this.failure;
  }
  async stop(): Promise<unknown> {
    const encoder = this.encoder;
    if (!encoder || encoder.isDestroyed()) throw new Error("No browser recording is available");
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      await this.bounded(this.pending);
      if (this.failure) throw this.failure;
      return await this.bounded(encoder.webContents.executeJavaScript("globalThis.finish()"));
    } finally {
      this.cancel();
    }
  }
  cancel(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.encoder && !this.encoder.isDestroyed()) this.encoder.destroy();
    this.encoder = null;
  }
}
