// Render a mock "web page screenshot" to a PNG data URL inside the extension service
// worker (OffscreenCanvas), avoiding any page lifecycle. Used to seed the editor for the
// smoke test and the screenshot capture.

export async function makeSampleDataUrlSW(sw, w = 1000, h = 620) {
  return sw.evaluate(
    async ({ w, h }) => {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      x.fillStyle = '#f4f6fa';
      x.fillRect(0, 0, w, h);
      // Top bar
      x.fillStyle = '#1f6feb';
      x.fillRect(0, 0, w, 64);
      x.fillStyle = '#ffffff';
      x.textBaseline = 'middle';
      x.font = 'bold 24px sans-serif';
      x.fillText('Example App', 24, 33);
      // Sidebar
      x.fillStyle = '#ffffff';
      x.fillRect(0, 64, 220, h - 64);
      x.fillStyle = '#e3e8ef';
      for (let i = 0; i < 6; i++) x.fillRect(20, 100 + i * 44, 180, 24);
      // Content card
      x.fillStyle = '#ffffff';
      x.fillRect(260, 100, w - 300, h - 160);
      x.fillStyle = '#0d1117';
      x.font = 'bold 28px sans-serif';
      x.fillText('Dashboard', 292, 142);
      x.fillStyle = '#9aa4b2';
      for (let i = 0; i < 5; i++) x.fillRect(292, 196 + i * 40, w - 360 - (i % 2) * 140, 16);
      // Primary button
      x.fillStyle = '#2da44e';
      x.fillRect(292, h - 150, 140, 40);
      x.fillStyle = '#ffffff';
      x.font = 'bold 16px sans-serif';
      x.fillText('Save', 348, h - 130);
      const blob = await c.convertToBlob({ type: 'image/png' });
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
    },
    { w, h }
  );
}
