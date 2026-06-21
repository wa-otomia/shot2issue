// Offscreen document: the service worker has no navigator.mediaDevices, so desktop capture
// runs here. Given a desktopCapture streamId, open the stream, grab one frame to a canvas,
// return it as a PNG data URL, and stop the tracks.

interface GrabMessage {
  target?: string;
  type?: string;
  streamId?: string;
}

chrome.runtime.onMessage.addListener((msg: GrabMessage, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'grab-frame' || !msg.streamId) return;
  grabFrame(msg.streamId)
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // async response
});

async function grabFrame(streamId: string): Promise<string> {
  const constraints = {
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } },
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    // Wait until the first frame has real dimensions.
    for (let i = 0; i < 30 && (!video.videoWidth || !video.videoHeight); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
