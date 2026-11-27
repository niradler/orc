import {
  SCRATCHPAD_FILES,
  SCRATCHPAD_KINDS,
  type ScratchpadKind,
  scratchpadFilename,
} from "@orc/core/scratchpad";
import { ttlDaysLeft } from "@orc/core/ttl";
import {
  ArrowLeft,
  Check,
  Download,
  Link2,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { ResponsiveFilters } from "@/components/ResponsiveFilters";
import { ScratchpadEditor } from "@/components/scratchpad/ScratchpadEditor";
import { ScratchpadFormDialog } from "@/components/scratchpad/ScratchpadFormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ViewHeader } from "@/components/ViewHeader";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useProjects } from "@/hooks/useProjects";
import {
  useDeleteScratchpad,
  useRestoreScratchpad,
  useScratchpad,
  useScratchpads,
} from "@/hooks/useScratchpads";
import { formatWhen } from "@/lib/live-sessions";
import { saveFile } from "@/lib/save-file";
import { KIND_META } from "@/lib/scratchpad-kinds";
import { SCRATCHPADS_PATH, scratchpadPath, scratchpadShareUrl } from "@/lib/scratchpad-routes";
import { formatBytes } from "@/lib/utils";
import { useViewParam } from "@/lib/view-params";

const ALL = "all";
const UNASSIGNED = "unassigned";
const LIST_LIMIT = 200;

/**
 * The project a new pad starts in: the list's project filter, else the sidebar's. Both use
 * "all" and "unassigned" as scopes, which are not projects.
 */
function newPadProject(filter: string, sidebar: string): string {
  if (filter === UNASSIGNED) return "";
  for (const scope of [filter, sidebar])
    if (scope && scope !== ALL && scope !== UNASSIGNED) return scope;
  return "";
}

/** Scratchpad timestamps are unix seconds. */
function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

export default function Scratchpads({ projectId }: { projectId: string }) {
  const { scratchpadId } = useParams();
  if (scratchpadId) return <ScratchpadPage key={scratchpadId} id={scratchpadId} />;
  return <ScratchpadList defaultProjectId={projectId} />;
}

function KindLabel({ kind }: { kind: ScratchpadKind }) {
  const { label, icon: Icon } = KIND_META[kind];
  return (
    <span className="inline-flex items-center gap-1.5 font-label text-xs text-muted-foreground">
      <Icon size={12} aria-hidden /> {label}
    </span>
  );
}

function ScratchpadList({ defaultProjectId }: { defaultProjectId: string }) {
  const desktop = useBreakpoint("lg");
  const navigate = useNavigate();
  const location = useLocation();
  const [project, setProject] = useViewParam<string>("project", defaultProjectId);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const legacyProject = params.get("padProject");
    if (!legacyProject) return;
    // Older pad links used a separate filter; migrate them to the shared project selection.
    if (!params.has("project")) params.set("project", legacyProject);
    params.delete("padProject");
    navigate({ search: params.toString() }, { replace: true });
  }, [location.search, navigate]);
  const [kind, setKind] = useViewParam<ScratchpadKind | typeof ALL>("padKind", ALL, [
    ALL,
    ...SCRATCHPAD_KINDS,
  ]);
  const [query, setQuery] = useViewParam<string>("padQuery", "");
  const [searchInput, setSearchInput] = useState(query);
  useEffect(() => setSearchInput(query), [query]);
  useEffect(() => {
    if (searchInput === query) return;
    const timer = setTimeout(() => setQuery(searchInput, { replace: true }), 350);
    return () => clearTimeout(timer);
  }, [searchInput, query, setQuery]);
  const [creating, setCreating] = useState(false);
  // The command palette opens the create dialog with ?new=1.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("new") !== "1") return;
    setCreating(true);
    params.delete("new");
    navigate({ search: params.toString() }, { replace: true });
  }, [location.search, navigate]);
  const { data: projects } = useProjects({ status: "active" });

  const list = useScratchpads({
    kind: kind === ALL ? undefined : kind,
    project_id: project === ALL || project === UNASSIGNED ? undefined : project,
    include_global: project !== ALL && project !== UNASSIGNED ? "true" : undefined,
    unassigned: project === UNASSIGNED ? "true" : undefined,
    q: query || undefined,
    limit: LIST_LIMIT,
  });
  const pads = list.data?.scratchpads ?? [];
  const projectName = (id: string | null) =>
    id ? (projects?.find((p) => p.id === id)?.name ?? id) : "Global";
  const filtered = Boolean(query) || kind !== ALL || project !== ALL;

  return (
    <div>
      <ViewHeader
        title="Scratchpads"
        compact
        help={
          <>
            Working docs, diagrams and HTML pages you or an agent keep and come back to. Agents
            create and edit them with the <code className="font-mono text-xs">pad_*</code> tools;
            share one by copying its link.
          </>
        }
        meta={list.data ? list.data.total : undefined}
        action={
          <Button
            data-testid="new-scratchpad-button"
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-sm"
          >
            <Plus size={12} className="mr-1" /> New
            <span className="sr-only sm:not-sr-only"> scratchpad</span>
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 lg:max-w-md">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search scratchpads"
            data-testid="scratchpad-search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(e.currentTarget.value)}
            placeholder="Search scratchpads…"
            className="h-11 pl-9 text-base lg:h-9 lg:text-sm"
          />
        </div>
        <ResponsiveFilters activeCount={Number(kind !== ALL) + Number(project !== ALL)}>
          <Select value={project} onValueChange={(value) => setProject(value)}>
            <SelectTrigger
              aria-label="Project"
              data-testid="scratchpad-project-filter"
              className="h-11 w-48 max-w-full bg-background font-body text-base text-on-surface lg:h-9 lg:text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-surface border-outline-variant">
              <SelectItem value={ALL} className="font-body text-sm">
                All projects
              </SelectItem>
              <SelectItem value={UNASSIGNED} className="font-body text-sm">
                Global
              </SelectItem>
              {projects?.map((p) => (
                <SelectItem
                  key={p.id}
                  value={p.id}
                  data-testid={`scratchpad-project-${p.id}`}
                  className="font-body text-sm"
                >
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            {([ALL, ...SCRATCHPAD_KINDS] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                data-testid={`scratchpad-kind-${value}`}
                aria-pressed={kind === value}
                className={`min-h-11 rounded-md font-label text-sm px-3 py-1.5 border transition-colors lg:min-h-9 focus-visible:outline-2 focus-visible:outline-focus ${
                  kind === value
                    ? "bg-surface-highest text-on-surface border-transparent"
                    : "bg-transparent border-transparent text-muted-foreground hover:bg-surface-low hover:text-on-surface"
                }`}
              >
                {value === ALL ? "All" : KIND_META[value].label}
              </button>
            ))}
          </div>
        </ResponsiveFilters>
      </div>

      {list.error ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : pads.length === 0 ? (
        <EmptyState message={filtered ? "No scratchpads match" : "No scratchpads yet"} />
      ) : (
        <div className="overflow-hidden">
          {desktop ? (
            <Table>
              <TableHeader>
                <TableRow className="border-b border-outline-variant hover:bg-transparent">
                  <TableHead className="font-label text-sm text-muted-foreground">Title</TableHead>
                  <TableHead className="font-label text-sm text-muted-foreground w-28">
                    Kind
                  </TableHead>
                  <TableHead className="font-label text-sm text-muted-foreground">
                    Project
                  </TableHead>
                  <TableHead className="font-label text-sm text-muted-foreground hidden md:table-cell">
                    Author
                  </TableHead>
                  <TableHead className="font-label text-sm text-muted-foreground w-20 hidden md:table-cell">
                    Size
                  </TableHead>
                  <TableHead className="font-label text-sm text-muted-foreground w-44">
                    Updated
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pads.map((pad) => (
                  <TableRow
                    key={pad.id}
                    data-testid="scratchpad-row"
                    data-scratchpad-id={pad.id}
                    className="border-b border-outline-variant/50 hover:bg-surface-low cursor-pointer"
                    onClick={() => navigate(`${scratchpadPath(pad.id)}${location.search}`)}
                  >
                    <TableCell className="font-body text-sm font-medium text-on-surface">
                      <Link
                        to={`${scratchpadPath(pad.id)}${location.search}`}
                        className="inline-flex min-h-11 items-center hover:text-primary"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {pad.title}
                      </Link>
                      {pad.tags.length > 0 && (
                        <span className="ml-2 font-label text-xs text-outline">
                          {pad.tags.map((t) => `#${t}`).join(" ")}
                        </span>
                      )}
                      {pad.delete_after && (
                        <span className="ml-2 font-label text-xs text-destructive">
                          deletes in {ttlDaysLeft(pad.delete_after)} days
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <KindLabel kind={pad.kind} />
                    </TableCell>
                    <TableCell className="font-body text-sm text-muted-foreground">
                      {projectName(pad.project_id)}
                    </TableCell>
                    <TableCell className="font-body text-sm text-muted-foreground hidden md:table-cell">
                      {pad.author}
                    </TableCell>
                    <TableCell className="font-label text-sm text-muted-foreground hidden md:table-cell">
                      {formatBytes(pad.size_bytes)}
                    </TableCell>
                    <TableCell className="font-label text-sm text-muted-foreground">
                      {formatTime(pad.updated_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="divide-y divide-border">
              {pads.map((pad) => (
                <Link
                  key={pad.id}
                  to={`${scratchpadPath(pad.id)}${location.search}`}
                  data-testid="scratchpad-row"
                  data-scratchpad-id={pad.id}
                  className="block min-h-11 py-3 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 break-words font-medium">{pad.title}</span>
                    <time
                      className="shrink-0 text-xs text-outline"
                      dateTime={new Date(pad.updated_at * 1000).toISOString()}
                      title={formatTime(pad.updated_at)}
                    >
                      {formatWhen(new Date(pad.updated_at * 1000).toISOString())}
                    </time>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-outline">
                    <KindLabel kind={pad.kind} />
                    <span>{projectName(pad.project_id)}</span>
                    <span>{pad.author}</span>
                    {pad.tags.length > 0 && (
                      <span>{pad.tags.map((tag) => `#${tag}`).join(" ")}</span>
                    )}
                    {pad.delete_after && (
                      <span className="text-destructive">
                        deletes in {ttlDaysLeft(pad.delete_after)} days
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {creating && (
        <ScratchpadFormDialog
          defaultProjectId={newPadProject(project, defaultProjectId)}
          onClose={() => setCreating(false)}
          onSaved={(pad) => navigate(scratchpadPath(pad.id))}
        />
      )}
    </div>
  );
}

function ScratchpadPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: pad, isLoading, error, refetch } = useScratchpad(id);
  const { data: projects } = useProjects();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [fullscreen, setFullscreen] = useState(false);
  const remove = useDeleteScratchpad();
  const restore = useRestoreScratchpad();
  const back = `${SCRATCHPADS_PATH}${location.search}`;

  useEffect(() => {
    if (copy !== "copied") return;
    const timer = setTimeout(() => setCopy("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copy]);

  // Escape leaves full screen unless a dialog or popup over the pad takes it first.
  useEffect(() => {
    if (!fullscreen) return;
    function leave(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      setFullscreen(false);
    }
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [fullscreen]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(scratchpadShareUrl(id));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  const backLink = (
    <Link
      to={back}
      className="inline-flex min-h-11 items-center gap-1.5 font-label text-sm text-muted-foreground hover:text-on-surface"
    >
      <ArrowLeft size={14} aria-hidden /> Scratchpads
    </Link>
  );
  if (error)
    return (
      <div>
        {backLink}
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </div>
    );
  if (isLoading || !pad)
    return (
      <div className="space-y-3">
        {backLink}
        <Skeleton className="h-8 w-1/2 bg-surface-highest" />
        <Skeleton className="h-64 w-full bg-surface-highest" />
      </div>
    );

  const project = pad.project_id ? projects?.find((p) => p.id === pad.project_id) : undefined;
  return (
    <div data-testid="scratchpad-page" data-scratchpad-kind={pad.kind} className="min-w-0">
      {backLink}
      <div className="mt-2 mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1
            data-testid="scratchpad-title"
            className="font-headline font-medium text-2xl tracking-tight text-on-surface wrap-break-word"
          >
            {pad.title}
          </h1>
          <div
            data-testid="scratchpad-meta"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-outline"
          >
            <KindLabel kind={pad.kind} />
            <span>revision {pad.revision}</span>
            <span>
              by <span data-testid="scratchpad-author">{pad.author}</span>,{" "}
              {formatTime(pad.updated_at)}
            </span>
            <span>{project?.name ?? (pad.project_id ? pad.project_id : "No project")}</span>
            {pad.session_id && (
              <span title="Agent session that created it">
                session <code className="font-mono text-xs">{pad.session_id.slice(0, 8)}</code>
              </span>
            )}
            {pad.tags.length > 0 && <span>{pad.tags.map((t) => `#${t}`).join(" ")}</span>}
            {pad.delete_after && (
              <span data-testid="scratchpad-deletes" className="text-destructive">
                deletes in {ttlDaysLeft(pad.delete_after)} days
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="scratchpad-fullscreen"
            size="sm"
            variant="outline"
            onClick={() => setFullscreen(true)}
          >
            <Maximize2 size={12} className="mr-1" /> Full screen
          </Button>
          <Button
            data-testid="scratchpad-copy-link"
            size="sm"
            variant="outline"
            onClick={() => void copyLink()}
          >
            {copy === "copied" ? (
              <Check size={12} className="mr-1" />
            ) : (
              <Link2 size={12} className="mr-1" />
            )}
            {copy === "copied" ? "Copied" : "Copy link"}
          </Button>
          <Button
            data-testid="scratchpad-download"
            size="sm"
            variant="outline"
            title="Download the saved file"
            onClick={() =>
              saveFile(
                new Blob([pad.content], { type: SCRATCHPAD_FILES[pad.kind].mime }),
                scratchpadFilename(pad.title, pad.kind),
              )
            }
          >
            <Download size={12} className="mr-1" /> Download
          </Button>
          <Button
            data-testid="scratchpad-properties"
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
          >
            <Settings2 size={12} className="mr-1" /> Properties
          </Button>
          {pad.delete_after ? (
            <Button
              data-testid="scratchpad-restore"
              size="sm"
              variant="outline"
              disabled={restore.isPending}
              onClick={() => restore.mutate(pad.id)}
            >
              <RotateCcw size={12} className="mr-1" /> Restore
            </Button>
          ) : (
            <Button
              data-testid="scratchpad-delete"
              size="sm"
              variant="outline"
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={12} className="mr-1" /> Delete
            </Button>
          )}
        </div>
      </div>
      {copy === "failed" && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          Clipboard access failed. Copy the link from the address bar instead.
        </p>
      )}

      {/* Dialogs sit at z-50, so the properties and access dialogs still open over full screen. */}
      <div
        data-testid="scratchpad-stage"
        data-fullscreen={fullscreen || undefined}
        className={
          fullscreen
            ? "fixed inset-0 z-40 flex flex-col gap-3 overflow-auto bg-background p-3 [--pad-height:calc(100dvh-8.5rem)] sm:p-4"
            : "min-w-0"
        }
      >
        {fullscreen && (
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate font-headline text-lg font-medium text-on-surface">
              {pad.title}
            </h2>
            <Button
              data-testid="scratchpad-exit-fullscreen"
              size="sm"
              variant="outline"
              onClick={() => setFullscreen(false)}
            >
              <Minimize2 size={12} className="mr-1" /> Exit full screen
            </Button>
          </div>
        )}
        <ScratchpadEditor pad={pad} />
      </div>

      {editing && <ScratchpadFormDialog pad={pad} onClose={() => setEditing(false)} />}
      {deleting && (
        <ConfirmDialog
          open
          title="Delete scratchpad"
          description={`Delete "${pad.title}"? It stays readable and is permanently removed after 30 days; restore it before then.`}
          confirmLabel="Delete"
          variant="destructive"
          isPending={remove.isPending}
          onConfirm={() =>
            remove.mutate(
              { id: pad.id },
              {
                onSuccess: () => {
                  setDeleting(false);
                  navigate(back);
                },
              },
            )
          }
          onCancel={() => setDeleting(false)}
        />
      )}
      {(remove.error || restore.error) && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {(remove.error ?? restore.error)?.message}
        </p>
      )}
    </div>
  );
}
