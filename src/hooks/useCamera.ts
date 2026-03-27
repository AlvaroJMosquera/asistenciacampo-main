import { useRef, useCallback, useState } from 'react';
import imageCompression from 'browser-image-compression';

interface CameraState {
  isCapturing: boolean;
  error: string | null;
}

function isAndroid() {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent);
}

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || ((navigator as any).maxTouchPoints > 1 && /MacIntel/.test(navigator.platform));
}

/**
 * Detecta si el dispositivo tiene poca RAM.
 * navigator.deviceMemory está disponible en Chrome/Android (en GB).
 * Si es <= 2 GB o no está disponible (dispositivo viejo), consideramos "low memory".
 */
function isLowMemoryDevice(): boolean {
  const mem = (navigator as any).deviceMemory as number | undefined;
  if (mem === undefined) return true; // dispositivo viejo = asumir bajo
  return mem <= 2;
}

function getCompressionOptions() {
  const isLow = isLowMemoryDevice();
  const isApple = isIOS(); // iOS gestiona la RAM de forma muy estricta (y a veces peor)

  if (isLow || isApple) {
    return {
      maxSizeMB: 0.2,            // 200KB es ideal para reportes técnicos
      maxWidthOrHeight: 800,     // Menos píxeles = Menos RAM al procesar el Canvas
      useWebWorker: false,       // Evitamos el "pico" de RAM de abrir un hilo nuevo
      initialQuality: 0.6,
      fileType: 'image/webp',    // WebP es más ligero de procesar
    };
  }

  // Configuración para equipos potentes
  return {
    maxSizeMB: 0.5,              // Calidad superior
    maxWidthOrHeight: 1280,      // Resolución HD
    useWebWorker: true,          // Aprovechamos los múltiples núcleos
    initialQuality: 0.8,
  };
}

export function useCamera() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<CameraState>({
    isCapturing: false,
    error: null,
  });

  const capturePhoto = useCallback((): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      // Limpia input anterior
      if (inputRef.current) {
        try {
          document.body.removeChild(inputRef.current);
        } catch {}
        inputRef.current = null;
      }

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';

      // ✅ Cámara trasera en campo (mejor)
      input.setAttribute('capture', 'environment');

      input.style.position = 'fixed';
      input.style.top = '-9999px';
      input.style.left = '-9999px';
      input.style.opacity = '0';
      document.body.appendChild(input);
      inputRef.current = input;

      setState({ isCapturing: true, error: null });

      let done = false;

      const cleanup = () => {
        try {
          if (inputRef.current?.parentNode) document.body.removeChild(inputRef.current);
        } catch {}
        inputRef.current = null;

        // OJO: en Android NO usamos visibility/focus (causan falsos cancel)
        if (!isAndroid()) {
          document.removeEventListener('visibilitychange', onVis);
          window.removeEventListener('focus', onFocus);
        }

        if (cancelTimer) window.clearTimeout(cancelTimer);
      };

      const finishReject = (msg: string) => {
        if (done) return;
        done = true;
        cleanup();
        setState({ isCapturing: false, error: msg });
        reject(new Error(msg));
      };

     const finishResolve = async (file: File) => {
  if (done) return;
  done = true;

  try {
    // IMPORTANTE: Liberamos el input del DOM ANTES de empezar la compresión
    cleanup(); 

    // Pausa táctica: Da tiempo al navegador para cerrar la interfaz de la cámara
    // y liberar los 100MB+ que consume el visor de cámara activo.
    await new Promise(r => setTimeout(r, 400));

    const options = getCompressionOptions();
    const compressed = await imageCompression(file, options);

    setState({ isCapturing: false, error: null });
    resolve(compressed);
  } catch (err) {
    // Si falla la compresión por falta de RAM, resolvemos con el archivo original 
    // pero avisamos en consola
    console.error("Fallo compresión, intentando enviar original", err);
    resolve(file); 
  }
};

      // ✅ Cancelación estable: solo por timeout largo
      const cancelMs = isAndroid() ? 45000 : 30000;
      const cancelTimer = window.setTimeout(() => {
        if (!done) finishReject('Captura cancelada');
      }, cancelMs);

      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          finishReject('Captura cancelada');
          return;
        }
        void finishResolve(file);
      };

      // ✅ SOLO iOS/desktop
      const onVis = () => {
        setTimeout(() => {
          if (!done && (!input.files || input.files.length === 0)) {
            // No rechazamos de inmediato: dejamos que el timeout principal decida.
          }
        }, 1500);
      };

      const onFocus = () => {
        setTimeout(() => {
          if (!done && (!input.files || input.files.length === 0)) {
            // Igual: no rechazamos aquí, solo dejamos que el timeout maneje.
          }
        }, 1200);
      };

      if (!isAndroid()) {
        document.addEventListener('visibilitychange', onVis);
        window.addEventListener('focus', onFocus);
      }

      // Disparar cámara/galería
      input.click();
    });
  }, []);

  return {
    ...state,
    capturePhoto,
  };
}