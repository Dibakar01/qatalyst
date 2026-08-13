'use client'

import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import { Fragment, useState } from 'react'
import type { ImportCounts } from '@/lib/contacts'
import { FIELDS, type Mapping, type Row } from '@/lib/csv'
import { importRows } from './actions'
import { accent, ghost } from './ui'

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
      ['Added', result.new],
      ['Already on the list', result.duplicate],
      ['Skipped — suppressed', result.suppressed],
      ['Rejected — malformed', result.malformed],
    ] as const
    return (
      <div className="space-y-4">
        <p className="text-muted">
          {fileName} — every one of the {rows.length} rows is accounted for below.
        </p>
        <dl className="divide-y divide-line rounded-xl border border-line">
          {lines.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between px-3.5 py-2.5">
              <dt className={value === 0 ? 'text-muted' : ''}>{label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {result.errors.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Why rows were rejected</p>
            <pre className="max-h-40 overflow-auto rounded-xl border border-line bg-canvas/60 p-3 text-[12px]">
              {result.errors.join('\n')}
            </pre>
          </div>
        )}
        <p className="text-muted">
          Importing this file again will add nothing — every row will come back as a duplicate.
        </p>
        <button
          onClick={() => {
            setResult(null)
            setRows([])
            setHeaders([])
            setFileName('')
          }}
          className={ghost}
        >
          Import another file
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <label className="block cursor-pointer rounded-xl border border-dashed border-line bg-raised/50 px-4 py-8 text-center transition-colors hover:border-accent/40">
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
        <span className="font-medium">{fileName || 'Choose a CSV file'}</span>
        <span className="mt-0.5 block text-muted">
          {rows.length > 0
            ? `${rows.length} rows, ${headers.length} columns`
            : 'Nothing is written until you map the columns and confirm.'}
        </span>
      </label>

      {rows.length > 0 && (
        <>
          <section>
            <h3 className="mb-1.5 font-medium">Map the columns</h3>
            <p className="mb-3 text-muted">
              Headers are never guessed. Map at least an email or a LinkedIn URL — anything you
              leave unmapped is kept on the contact as context, not discarded.
            </p>
            <div className="grid grid-cols-[10rem_1fr] items-center gap-x-3 gap-y-1.5">
              {FIELDS.map((field) => (
                <Fragment key={field}>
                  <label htmlFor={`map-${field}`} className="font-mono text-[12px] text-muted">
                    {field}
                  </label>
                  <select
                    id={`map-${field}`}
                    value={mapping[field] ?? ''}
                    onChange={(e) =>
                      setMapping({ ...mapping, [field]: e.target.value || undefined })
                    }
                    className="rounded-lg border border-line bg-raised px-2 py-1.5"
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
            <h3 className="mb-1.5 font-medium">First five rows</h3>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full border-collapse whitespace-nowrap text-[12px]">
                <thead>
                  <tr className="bg-raised">
                    {headers.map((header) => (
                      <th
                        key={header}
                        className="border-b border-line px-2.5 py-1.5 text-left font-medium"
                      >
                        {header}
                        {claimed.has(header) ? (
                          ''
                        ) : (
                          <span className="ml-1 font-normal text-muted">context</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((row, index) => (
                    <tr key={index}>
                      {headers.map((header) => (
                        <td key={header} className="border-b border-line px-2.5 py-1.5">
                          {row[header]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="flex items-center gap-3 border-t border-line pt-4">
            <button
              onClick={run}
              disabled={!ready || busy}
              className={accent}
            >
              {busy ? 'Importing…' : `Import ${rows.length} rows`}
            </button>
            {!ready && <span className="text-muted">Map email or linkedin_url to continue.</span>}
          </div>
        </>
      )}
    </div>
  )
}
