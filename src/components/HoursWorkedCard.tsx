import { Clock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface HoursWorkedCardProps {
  hours: number | null;
}

export function HoursWorkedCard({ hours }: HoursWorkedCardProps) {
  if (hours === null) return null;

  const formattedHours = hours.toFixed(1);
  const hoursInt = Math.floor(hours);
  const minutes = Math.round((hours - hoursInt) * 60);

  return (
    <Card className="bg-accent/20 border-accent/30">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-accent/30">
            <Clock className="h-6 w-6 text-accent-foreground" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Tiempo trabajado hoy</p>
            <p className="text-2xl font-bold text-foreground">
              {hoursInt}h {minutes}min
              <span className="text-base font-normal text-muted-foreground ml-2">
                ({formattedHours} hrs)
              </span>
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
