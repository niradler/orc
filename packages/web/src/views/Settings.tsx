import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Save } from "lucide-react";
import { useState } from "react";
import { getApiSecret, getApiUrl } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ViewHeader } from "@/components/ViewHeader";

export default function Settings() {
  const [apiUrl, setApiUrl] = useState(getApiUrl);
  const [apiSecret, setApiSecret] = useState(getApiSecret);
  const [saved, setSaved] = useState(false);
  const qc = useQueryClient();

  const handleSave = () => {
    localStorage.setItem("orc_api_url", apiUrl.trim() || "/api");
    localStorage.setItem("orc_api_secret", apiSecret.trim());
    qc.invalidateQueries();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    localStorage.removeItem("orc_api_url");
    localStorage.removeItem("orc_api_secret");
    setApiUrl("/api");
    setApiSecret("");
    qc.invalidateQueries();
  };

  return (
    <div>
      <ViewHeader title="Settings" />

      <div className="max-w-lg space-y-8">
        {/* API Configuration */}
        <section>
          <h2 className="font-headline font-bold text-xs uppercase tracking-widest text-on-surface mb-1">
            API Configuration
          </h2>
          <p className="font-body text-xs text-outline mb-4">
            Configure how the frontend connects to the ORC API server. In development, the default{" "}
            <code className="text-primary">/api</code> is proxied by Vite to{" "}
            <code className="text-primary">localhost:7700</code>.
          </p>
          <Separator className="bg-surface-highest mb-4" />
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                API Base URL
              </Label>
              <Input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="/api  or  http://localhost:7700"
                className="bg-surface-highest border-surface-highest text-on-surface font-body text-sm"
              />
              <p className="font-body text-[10px] text-outline">
                Use <code>/api</code> (dev proxy) or a direct URL when CORS is enabled.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                API Secret (Bearer Token)
              </Label>
              <Input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="Leave empty if no auth required"
                className="bg-surface-highest border-surface-highest text-on-surface font-body text-sm"
              />
            </div>
          </div>
        </section>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button
            onClick={handleSave}
            className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
          >
            {saved ? (
              <>
                <CheckCircle size={12} className="mr-1.5 text-secondary" /> Saved
              </>
            ) : (
              <>
                <Save size={12} className="mr-1.5" /> Save Settings
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={handleReset}
            className="font-label text-xs uppercase text-outline hover:text-on-surface"
          >
            Reset to Defaults
          </Button>
        </div>

        {/* Info */}
        <section>
          <Separator className="bg-surface-highest mb-4" />
          <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-2">
            Storage
          </div>
          <p className="font-body text-xs text-outline">
            Settings are persisted in <code className="text-primary">localStorage</code> and survive
            page reloads. Clearing browser storage resets to defaults.
          </p>
        </section>
      </div>
    </div>
  );
}
