import { Fragment } from 'react';

export function Email({ value }: { value: string }) {
  return (
    <>
      {Array.from(value.matchAll(/[^@._-]+[@._-]?|[@._-]/g), (part) => (
        <Fragment key={part.index}>
          <span className="whitespace-nowrap">{part[0]}</span>
          <wbr />
        </Fragment>
      ))}
    </>
  );
}
