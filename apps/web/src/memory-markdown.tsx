import { ImageOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Checkbox } from '@/components/ui/checkbox';

// The detail header already shows the first heading. Raw HTML stays literal;
// no HTML parser or plugin is allowed to turn stored text into DOM elements.
function omitInitialHeading() {
  return (tree: { children: { type: string }[] }) => {
    if (tree.children[0]?.type === 'heading') tree.children.shift();
  };
}
export function MemoryMarkdown({ content }: { content: string }) {
  return (
    <div data-memory-markdown className="text-sm leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, omitInitialHeading]}
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
