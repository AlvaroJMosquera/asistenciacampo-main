import { useState, useCallback } from 'react';

interface GeolocationData {
  latitude: number;
  longitude: number;
  accuracy: number;
}

interface GeolocationState {
  data: GeolocationData | null;
  error: string | null;
  isLoading: boolean;
}

export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    data: null,
    error: null,
    isLoading: false,
  });

  const getCurrentPosition = useCallback((): Promise<GeolocationData> => {
    return new Promise((resolve, reject) => {
      setState({ data: null, error: null, isLoading: true });

      if (!navigator.geolocation) {
        const error = 'Geolocalización no soportada en este dispositivo';
        setState({ data: null, error, isLoading: false });
        reject(new Error(error));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const data: GeolocationData = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          };
          setState({ data, error: null, isLoading: false });
          resolve(data);
        },
        (error) => {
          let errorMessage = 'Error obteniendo ubicación';
          switch (error.code) {
            case error.PERMISSION_DENIED:
              errorMessage = 'Permiso de ubicación denegado. Por favor, habilita el GPS.';
              break;
            case error.POSITION_UNAVAILABLE:
              errorMessage = 'Ubicación no disponible. Verifica tu conexión GPS.';
              break;
            case error.TIMEOUT:
              errorMessage = 'Tiempo de espera agotado. Intenta de nuevo.';
              break;
          }
          setState({ data: null, error: errorMessage, isLoading: false });
          reject(new Error(errorMessage));
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0,
        }
      );
    });
  }, []);

  return {
    ...state,
    getCurrentPosition,
  };
}
