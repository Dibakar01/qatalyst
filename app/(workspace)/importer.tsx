'use client'

import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import { Fragment, useState } from 'react'
import type { ImportCounts } from '@/lib/contacts'
import { FIELDS, type Mapping, type Row } from '@/lib/csv'
import { importRows } from './actions'
import { go, quiet } from './ui'

export default function Importer() {
  const router = useRouter()
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [mapping, setMapping] = useState<Mapping>({})
  const [result, setResult] = useState<ImportCounts | null>(null)
  const [busy, setBusy] = useState(false)

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        setFileName(file.name)
        setHeaders(parsed.meta.fields ?? [])
        setRows(parsed.data)
        // Deliberately not guessing: an unmapped column is kept as context,
        // a wrongly guessed one is silently wrong data.
        setMapping({})
        setResult(null)
      },
    })
  }

  const claimed = new Set(Object.values(mapping).filter(Boolean))
  const ready = Boolean(mapping.email || mapping.linkedin_url) && rows.length > 0

  async function run() {
    setBusy(true)
    try {
      setResult(await importRows(mapping, rows, fileName))
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    const lines = [
      ['Added to the book', result.new],
      ['Already in it', result.duplicate],
      ['Skipped — returned', result.suppressed],
      ['Rejected — malformed', result.malformed],
    ] as const
    return (
      <div className="space-y-5">
        <p className="text-dim">
          {fileName} — every one of the {rows.length} rows is accounted for below.
        </p>
        <dl className="divide-y divide-line rounded-[5px] border border-line">
          {lines.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between px-3 py-2">
              <dt className={value === 0 ? 'text-dim' : ''}>{label}</dt>
              <dd className="text-title font-medium leading-none tracking-[-0.03em]">{value}</dd>
            </div>
          ))}
        </dl>
        {result.errors.length > 0 && (
          <div>
            <p className="mb-1.5 font-medium">Why rows were rejected</p>
            <pre className="quiet-scroll max-h-40 rounded-[5px] border border-line bg-raise p-3 text-small">
              {result.errors.join('\n')}
            </pre>
          </div>
        )}
        <p className="text-dim">
          Taking the same file in again will add nothing — every row will come back as already in
          the book.
        </p>
        <button
          onClick={() => {
            setResult(null)
            setRows([])
            setHeaders([])
            setFileName('')
          }}
          className={quiet}
        >
          Take in another
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <label className="block cursor-pointer rounded-[5px] border border-dashed border-line bg-raise p-6 text-center transition-colors hover:border-primary hover:bg-raise">
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
        <span className="block text-title font-medium tracking-[-0.02em]">{fileName || 'Choose a CSV file'}</span>
        <span className="mt-1 block text-dim">
          {rows.length > 0
            ? `${rows.length} rows, ${headers.length} columns`
            : 'Nothing is written until you map the columns and confirm.'}
        </span>
      </label>

      {rows.length > 0 && (
        <>
          <section>
            <h3 className="mb-1.5 font-medium">Map the columns</h3>
            <p className="mb-3 text-dim">
              Headers are never guessed. Map at least an address or a LinkedIn URL — anything you
              leave unmapped is kept on the person as context, not discarded.
            </p>
            <div className="grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[7rem_1fr_7rem_1fr]">
              {FIELDS.map((name) => (
                <Fragment key={name}>
                  <label
                    htmlFor={`map-${name}`}
                    className="text-micro uppercase tracking-[0.16em] text-dim"
                  >
                    {name}
                  </label>
                  <select
                    id={`map-${name}`}
                    value={mapping[name] ?? ''}
                    onChange={(e) => setMapping({ ...mapping, [name]: e.target.value || undefined })}
                    className="rounded-[5px] border border-line bg-raise px-3 py-2"
                  >
                    <option value="">— not mapped —</option>
                    {headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </Fragment>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-1.5 font-medium">What the first row becomes</h3>
            <p className="mb-2.5 text-dim">
              If this is not the person you expect, the mapping above is wrong.
            </p>
            <dl className="grid grid-cols-[7rem_1fr] gap-y-1 rounded-[5px] border border-line px-3 py-2">
              {FIELDS.filter((name) => mapping[name]).map((name) => (
                <Fragment key={name}>
                  <dt className="text-micro uppercase tracking-[0.16em] text-dim">{name}</dt>
                  <dd className="truncate">{rows[0]?.[mapping[name]!] || '—'}</dd>
                </Fragment>
              ))}
              <dt className="text-micro uppercase tracking-[0.16em] text-dim">context</dt>
              <dd className="truncate text-dim">
                {headers.filter((h) => !claimed.has(h)).join(', ') || 'nothing left over'}
              </dd>
            </dl>
          </section>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <button onClick={run} disabled={!ready || busy} className={go}>
              {busy ? 'Taking them in…' : `Take in ${rows.length} rows`}
            </button>
            {!ready && <span className="text-dim">Map email or linkedin_url to continue.</span>}
          </div>
        </>
      )}
    </div>
  )
}
