import { Card, CardContent } from '@/components/ui/card';
import { AlertCircle } from 'lucide-react';

// Theme tokens, not hardcoded grays -- this page previously rendered a
// light-mode card inside the dark shell (found in the visual pass,
// 2026-08-25). It is now routed for unknown paths, so it must read as part
// of the app in both themes.
export default function NotFound() {
  return (
    <div className="min-h-[60vh] w-full flex items-center justify-center">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2 items-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <h1 className="text-2xl font-bold text-foreground">
              404 Page Not Found
            </h1>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            That route does not exist. Use the sidebar to get back on track.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
