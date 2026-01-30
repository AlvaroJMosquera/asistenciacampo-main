import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSyncService } from '@/hooks/useSyncService';
import { Wifi, WifiOff, Cloud, CloudOff, Loader2 } from 'lucide-react';

export function SyncStatusBadge() {
  const { isOnline } = useOnlineStatus();
  const { pendingCount, isSyncing } = useSyncService();

  if (isSyncing) {
    return (
      <div className="sync-indicator bg-primary/20 text-primary">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Sincronizando...</span>
      </div>
    );
  }

  if (!isOnline) {
    return (
      <div className="sync-indicator sync-offline">
        <WifiOff className="h-4 w-4" />
        <span>Sin conexión</span>
      </div>
    );
  }

  if (pendingCount > 0) {
    return (
      <div className="sync-indicator sync-pending">
        <CloudOff className="h-4 w-4" />
        <span>{pendingCount} pendiente{pendingCount > 1 ? 's' : ''}</span>
      </div>
    );
  }

  return (
    <div className="sync-indicator sync-success">
      <Cloud className="h-4 w-4" />
      <span>Sincronizado</span>
    </div>
  );
}
