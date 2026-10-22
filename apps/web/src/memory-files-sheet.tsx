import {
  memoryTitle,
  type OwnerMemory,
  type OwnerMemoryFile,
} from '@nook/contract';
import {
  ChevronDown,
  CircleAlert,
  Download,
  FileArchive,
  File as FileIcon,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  Paperclip,
} from 'lucide-react';
import type { RefObject } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { describeFailure } from './api-client';
import { type DownloadFailure, useFileDownload } from './memory-file-download';
import { clientName, principalName } from './memory-format';
import { formatDateTime, timeAgo } from './time';
import type { MemoryPageModel } from './use-memory-page';

const units = ['B', 'KiB', 'MiB'] as const;
function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text =
    unit === 0 || Number.isInteger(value)
      ? String(value)
      : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}

function mediaIcon(mediaType: string) {
  if (mediaType.startsWith('image/')) return FileImage;
  if (mediaType.includes('zip')) return FileArchive;
  if (mediaType.includes('csv') || mediaType.includes('spreadsheet'))
    return FileSpreadsheet;
  if (mediaType.includes('json')) return FileJson;
  if (mediaType === 'application/pdf' || mediaType.startsWith('text/'))
    return FileText;
  return FileIcon;
}

function DownloadButton({
  file,
  pending,
  blocked,
  download,
}: {
  file: OwnerMemoryFile;
  pending: boolean;
  blocked: boolean;
  download: (name: string) => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      data-file-download={file.name}
      aria-label={`Download ${file.name}`}
      aria-busy={pending}
      disabled={blocked}
      onClick={() => download(file.name)}
    >
      {pending ? <Spinner /> : <Download />}
      <span className="max-sm:sr-only">
        {pending ? 'Downloading…' : 'Download'}
      </span>
    </Button>
  );
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium wrap-anywhere">{children}</dd>
    </div>
  );
}

function FileRow({
  file,
  pending,
  blocked,
  download,
}: {
  file: OwnerMemoryFile;
  pending: boolean;
  blocked: boolean;
  download: (name: string) => void;
}) {
  const Icon = mediaIcon(file.mediaType);
  return (
    <li data-file-row={file.name}>
      <Collapsible>
        <Item size="sm" className="min-w-0 flex-nowrap items-start">
          <ItemMedia variant="icon">
            <Icon />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <div className="flex min-w-0 flex-col gap-0.5">
              <ItemTitle className="block min-w-0 max-w-full">
                <span className="line-clamp-3 wrap-anywhere" title={file.name}>
                  {file.name}
                </span>
              </ItemTitle>
              <p className="text-xs text-muted-foreground wrap-anywhere">
                <span className="tabular-nums">{formatBytes(file.size)}</span>
                <span aria-hidden> · </span>
                <span className="font-mono">{file.mediaType}</span>
              </p>
              <p className="text-xs text-muted-foreground wrap-anywhere">
                Attached{' '}
                <time
                  dateTime={file.attachedAt}
                  title={timeAgo(file.attachedAt)}
                  className="tabular-nums"
                >
                  {formatDateTime(file.attachedAt)}
                </time>{' '}
                by{' '}
                {principalName({ provenance: { principal: file.principal } })}
              </p>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="-ml-2 mt-1 w-fit [&[data-state=open]>svg]:rotate-180"
                >
                  Details
                  <ChevronDown />
                </Button>
              </CollapsibleTrigger>
            </div>
          </ItemContent>
          <ItemActions className="shrink-0">
            <DownloadButton
              file={file}
              pending={pending}
              blocked={blocked}
              download={download}
            />
          </ItemActions>
        </Item>
        <CollapsibleContent>
          <dl className="mx-4 mb-3 grid gap-3 rounded-md border bg-muted/30 p-3 text-xs">
            <Fact label="Name">{file.name}</Fact>
            <Fact label="Size">{`${file.size.toLocaleString('en-US')} bytes`}</Fact>
            <div>
              <dt className="text-muted-foreground">SHA-256</dt>
              <dd className="mt-0.5 break-all font-mono font-medium">
                {file.sha256}
              </dd>
            </div>
            <Fact label="Client (as reported)">{clientName(file.client)}</Fact>
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function refreshStatus(failure: DownloadFailure, refreshing: boolean) {
  if (refreshing) return 'Refreshing the list…';
  return failure.refreshFailed
    ? 'Could not refresh the list. Try again.'
    : 'The list is up to date.';
}

function FailureAlert({
  failure,
  refreshing,
  blocked,
  files,
  download,
}: {
  failure: DownloadFailure;
  refreshing: boolean;
  files: readonly OwnerMemoryFile[];
  blocked: boolean;
  download: (name: string) => void;
}) {
  const retry = files.find((file) => file.name === failure.name);
  return (
    <div className="shrink-0 p-4">
      <Alert variant="destructive" data-file-problem={failure.kind}>
        <CircleAlert />
        <AlertTitle wrap>
          {failure.kind === 'missing'
            ? 'File not found.'
            : 'Could not download the file'}
        </AlertTitle>
        <AlertDescription>
          {failure.kind === 'missing' ? (
            <p className="wrap-anywhere">
              “{failure.name}” was detached or replaced since this page loaded.{' '}
              {refreshStatus(failure, refreshing)}
            </p>
          ) : (
            <p className="wrap-anywhere">
              {describeFailure(
                failure.error,
                'download files',
                `“${failure.name}” was not saved.`,
              )}
            </p>
          )}
          {retry &&
            (failure.kind === 'unavailable' || failure.refreshFailed) && (
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                disabled={blocked}
                onClick={() => download(retry.name)}
              >
                Try again
              </Button>
            )}
        </AlertDescription>
      </Alert>
    </div>
  );
}

function newestFirst(files: readonly OwnerMemoryFile[]) {
  return [...files].sort(
    (a, b) => Date.parse(b.attachedAt) - Date.parse(a.attachedAt),
  );
}

export function FilesSheet({
  model,
  memory,
  returnFocus,
}: {
  model: MemoryPageModel;
  memory: OwnerMemory;
  /** The Files button that opened the sheet; focus goes back to it on close. */
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const { files } = memory;
  const { pending, failure, refreshing, download } = useFileDownload(
    memory.id,
    model.detail,
  );
  const rows = newestFirst(files);
  return (
    <Sheet
      open={model.filesOpen}
      onOpenChange={(open) => {
        if (!open) model.closeFiles();
      }}
    >
      <SheetContent
        data-files-sheet
        className="w-full sm:max-w-md"
        layout="stacked"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (
            returnFocus.current ??
            document.querySelector<HTMLElement>('[data-memory-history]')
          )?.focus({ preventScroll: true });
        }}
      >
        <SheetHeader className="shrink-0">
          <div className="pr-8">
            <SheetTitle>Files</SheetTitle>
            <SheetDescription className="wrap-anywhere">
              {rows.length === 0
                ? 'No files on '
                : rows.length === 1
                  ? '1 file on '
                  : `${rows.length} files on `}
              “{memoryTitle(memory.content)}”
              {rows.length > 1 && ', newest first'}. A file belongs to the
              memory, not to one version.
            </SheetDescription>
          </div>
        </SheetHeader>
        <Separator />
        {failure && (
          <>
            <FailureAlert
              failure={failure}
              refreshing={refreshing}
              files={files}
              blocked={pending !== null}
              download={download}
            />
            <Separator />
          </>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length ? (
            <ul className="divide-y" aria-label="Files, newest first">
              {rows.map((file) => (
                <FileRow
                  key={file.name}
                  file={file}
                  pending={pending === file.name}
                  blocked={pending !== null}
                  download={download}
                />
              ))}
            </ul>
          ) : (
            <div className="px-5 py-12">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Paperclip />
                  </EmptyMedia>
                  <EmptyTitle>No files attached</EmptyTitle>
                  <EmptyDescription>
                    Agents attach files to a memory with the CLI.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
