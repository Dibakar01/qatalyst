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
        <dl className="divide-y divide-rule rounded-[3px] border border-rule">
          {lines.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between px-4 py-3">
              <dt className={value === 0 ? 'text-dim' : ''}>{label}</dt>
              <dd className="font-serif text-[21px] leading-none">{value}</dd>
            </div>
          ))}
        </dl>
        {result.errors.length > 0 && (
          <div>
            <p className="mb-1.5 font-serif text-[17px]">Why rows were rejected</p>
            <pre className="max-h-40 overflow-auto rounded-[3px] border border-rule bg-white/60 p-3 font-mono text-[11.5px]">
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
      <label className="block cursor-pointer rounded-[3px] border border-dashed border-rule bg-white/50 px-4 py-10 text-center transition-colors hover:border-ink/40 hover:bg-white/70">
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
        <span className="block font-serif text-[19px]">{fileName || 'Choose a CSV file'}</span>
        <span className="mt-1 block text-dim">
          {rows.length > 0
            ? `${rows.length} rows, ${headers.length} columns`
            : 'Nothing is written until you map the columns and confirm.'}
        </span>
      </label>

      {rows.length > 0 && (
        <>
          <section>
            <h3 className="mb-1.5 font-serif text-[17px]">Map the columns</h3>
            <p className="mb-3 text-dim">
              Headers are never guessed. Map at least an address or a LinkedIn URL — anything you
              leave unmapped is kept on the person as context, not discarded.
            </p>
            <div className="grid grid-cols-[9rem_1fr] items-center gap-x-3 gap-y-2">
              {FIELDS.map((name) => (
                <Fragment key={name}>
                  <label
                    htmlFor={`map-${name}`}
                    className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim"
                  >
                    {name}
                  </label>
                  <select
                    id={`map-${name}`}
                    value={mapping[name] ?? ''}
                    onChange={(e) => setMapping({ ...mapping, [name]: e.target.value || undefined })}
                    className="rounded-[3px] border border-rule bg-white/60 px-2 py-1.5"
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
            <h3 className="mb-1.5 font-serif text-[17px]">First five rows</h3>
            <div className="overflow-x-auto rounded-[3px] border border-rule">
              <table className="w-full border-collapse whitespace-nowrap text-[12px]">
                <thead>
                  <tr className="bg-ink/[0.04]">
                    {headers.map((header) => (
                      <th
                        key={header}
                        className="border-b border-rule px-2.5 py-2 text-left font-medium"
                      >
                        {header}
                        {claimed.has(header) ? (
                          ''
                        ) : (
                          <span className="ml-1.5 font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-dim">
                            context
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((row, index) => (
                    <tr key={index}>
                      {headers.map((header) => (
                        <td key={header} className="border-b border-rule/60 px-2.5 py-1.5">
                          {row[header]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-5">
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
