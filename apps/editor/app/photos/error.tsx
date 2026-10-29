'use client'

import Link from 'next/link'

/** Shown instead of a raw crash if anything on the photos page fails while rendering. */
export default function PhotosError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const button = {
    height: 44,
    padding: '0 20px',
    borderRadius: 11,
    border: '1px solid rgba(255,255,255,.18)',
    background: 'transparent',
    color: '#ececec',
    font: 'inherit',
    fontSize: 14.5,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    textDecoration: 'none',
  } as const
  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#141414',
        color: '#ececec',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
    >
      <section
        style={{
          maxWidth: 520,
          width: '100%',
          background: '#1b1b1c',
          border: '1px solid rgba(255,138,138,.4)',
          borderRadius: 14,
          padding: 22,
        }}
        role="alert"
      >
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Something went wrong on this page
        </h1>
        <p style={{ margin: '8px 0 0', color: '#a1a1a6', fontSize: 14 }}>
          Your photos weren’t lost on the server. Try again, and if it keeps happening, send the
          message below.
        </p>
        <pre
          style={{
            margin: '12px 0 0',
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(0,0,0,.28)',
            font: '12.5px/1.55 ui-monospace, Menlo, Consolas, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {error.message || 'Unknown error'}
        </pre>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={reset}
            style={{ ...button, background: '#ececec', color: '#141414', border: 0 }}
          >
            Try again
          </button>
          <Link href="/" style={button}>
            Back to editor
          </Link>
        </div>
      </section>
    </main>
  )
}
