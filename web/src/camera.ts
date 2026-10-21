import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import jsQR from 'jsqr';
import { decodeQr, QrPayload } from './protocol';

export async function openCamera(video: HTMLVideoElement, facing: 'user' | 'environment'): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access needs a secure (https) page and a browser that supports it.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  return () => { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
}

/** Reads frames until a Haazir QR code appears. Codes that are not ours are ignored. */
export function scanForCode(video: HTMLVideoElement, signal: AbortSignal): Promise<QrPayload> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return new Promise((resolve, reject) => {
    const frame = () => {
      if (signal.aborted) { reject(new DOMException('cancelled', 'AbortError')); return; }
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.min(1, 720 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        const payload = code ? decodeQr(code.data) : null;
        if (payload) { resolve(payload); return; }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// ------------------------------------------------------------------ liveness

let landmarker: Promise<FaceLandmarker> | null = null;

/** Loads the on-device face model once. Nothing about the face leaves the phone. */
function loadLandmarker(): Promise<FaceLandmarker> {
  if (!landmarker) {
    landmarker = (async () => {
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const options = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
        outputFaceBlendshapes: true, runningMode: 'VIDEO' as const, numFaces: 2,
      });
      try {
        return await FaceLandmarker.createFromOptions(files, options('GPU'));
      } catch {
        return FaceLandmarker.createFromOptions(files, options('CPU'));
      }
    })();
  }
  return landmarker;
}

export interface LivenessResult {
  method: 'mediapipe-face-landmarker';
  challenge: string;
  blinks: number;
  framesAnalysed: number;
  passed: boolean;
  /** Fresh per attempt, so no two results hash the same. */
  attemptNonce: string;
  completedAt: string;
}

/**
 * Active liveness: blink a randomly chosen number of times, with exactly one
 * face in view throughout.
 *
 * A random count defeats a looped video of someone blinking a fixed number
 * of times. What this does NOT do is prove whose face it is — matching against
 * an enrolment template is future work, stated in the report as such. Only a
 * digest of this result is ever signed and sent; no image, no landmarks.
 */
export async function runLiveness(
  video: HTMLVideoElement,
  onProgress: (message: string) => void,
  signal: AbortSignal,
): Promise<LivenessResult> {
  onProgress('Loading the on-device face model…');
  const model = await loadLandmarker();

  const required = 2 + Math.floor(Math.random() * 2);   // 2 or 3
  const attemptNonce = Array.from(crypto.getRandomValues(new Uint8Array(8)),
    (b) => b.toString(16).padStart(2, '0')).join('');
  const deadline = performance.now() + 12_000;
  let blinks = 0;
  let closed = false;
  let frames = 0;
  let lastFaceAt = performance.now();

  onProgress(`Blink ${required} times`);
  return new Promise((resolve, reject) => {
    const finish = (passed: boolean, why?: string) => {
      if (!passed && why) { reject(new Error(why)); return; }
      resolve({
        method: 'mediapipe-face-landmarker', challenge: `blink-${required}`, blinks,
        framesAnalysed: frames, passed, attemptNonce, completedAt: new Date().toISOString(),
      });
    };
    const step = () => {
      if (signal.aborted) { reject(new DOMException('cancelled', 'AbortError')); return; }
      const now = performance.now();
      if (now > deadline) { finish(false, `Liveness check timed out (${blinks}/${required} blinks seen).`); return; }
      if (video.readyState >= 2) {
        const res = model.detectForVideo(video, now);
        frames += 1;
        const faces = res.faceBlendshapes?.length ?? 0;
        if (faces > 1) { finish(false, 'More than one face is in view.'); return; }
        if (faces === 1) {
          lastFaceAt = now;
          const score = (name: string) => res.faceBlendshapes[0].categories
            .find((c) => c.categoryName === name)?.score ?? 0;
          const eyes = Math.max(score('eyeBlinkLeft'), score('eyeBlinkRight'));
          if (!closed && eyes > 0.55) closed = true;
          else if (closed && eyes < 0.25) {
            closed = false;
            blinks += 1;
            onProgress(blinks >= required ? 'Done' : `Blink ${required - blinks} more time${required - blinks === 1 ? '' : 's'}`);
            if (blinks >= required) { finish(true); return; }
          }
        } else if (now - lastFaceAt > 1500) {
          onProgress('Keep your face in the frame');
        }
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
