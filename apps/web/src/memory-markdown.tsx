import { memoryTitle } from '@nook/contract';
import { ImageOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Checkbox } from '@/components/ui/checkbox';

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};
// Omit only a plain heading that the detail title shows in full. Keep long,
// multiline, and formatted headings so the complete stored content survives.
function omitInitialHeading({ title }: { title: string }) {
  return (tree: { children: MarkdownNode[] }) => {
    const heading = tree.children[0];
    const children = heading?.children;
    if (
      heading?.type === 'heading' &&
      children?.length === 1 &&
      children[0].type === 'text' &&
      children[0].value === title
    )
      tree.children.shift();
  };
}
export function MemoryMarkdown({ content }: { content: string }) {
  return (
    <div data-memory-markdown className="text-sm leading-7">
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          [omitInitialHeading, { title: memoryTitle(content) }],
        ]}
        urlTransform={(url) => url}
        components={{
          a: ({ href, children }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ src, alt }) => (
            <span className="inline-flex max-w-full items-baseline gap-1.5 rounded-md border border-dashed px-2 py-0.5 align-baseline text-xs text-muted-foreground">
              <ImageOff
                className="size-3 shrink-0 translate-y-0.5"
                aria-hidden
              />
              <span className="min-w-0">
                Image not loaded{alt ? `: ${alt}` : ''} —{' '}
                <span className="font-mono wrap-anywhere">
                  {typeof src === 'string' ? src : ''}
                </span>
              </span>
            </span>
          ),
          input: ({ checked }) => (
            <Checkbox checked={checked} disabled aria-label="Stored task" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
