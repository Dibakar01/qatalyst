'use client'

import Papa from 'papaparse'
import { Fragment, useState } from 'react'
import type { ImportCounts } from '@/lib/contacts'
import { FIELDS, type Mapping, type Row } from '@/lib/csv'
import { importRows } from './actions'

export default function Importer() {
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [mapping, setMapping] = useState<Mapping>({})
  const [result, setResult] = useState<ImportCounts | null>(null)
  const [busy, setBusy] = useState(false)

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
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
  const canImport = Boolean(mapping.email || mapping.linkedin_url) && rows.length > 0 && !busy

  async function run() {
    setBusy(true)
    try {
      setResult(await importRows(mapping, rows, fileName))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-2 font-medium">Import CSV</h1>
        <input type="file" accept=".csv,text/csv" onChange={onFile} />
      </div>

      {rows.length > 0 && (
        <>
          <p className="text-neutral-600">
            {fileName} — {rows.length} rows, {headers.length} columns
          </p>

          <section>
            <h2 className="mb-1 font-medium">Preview (first 5 rows)</h2>
            <div className="overflow-x-auto border border-neutral-300">
              <table className="min-w-full border-collapse">
                <thead className="bg-neutral-100">
                  <tr>
                    {headers.map((h) => (
                      <th key={h} className="border border-neutral-300 px-2 py-1 text-left">
                        {h}
                        {claimed.has(h) ? '' : ' *'}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((r, i) => (
                    <tr key={i}>
                      {headers.map((h) => (
                        <td key={h} className="border border-neutral-300 px-2 py-1">
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-neutral-600">* unmapped — stored in contact context</p>
          </section>

          <section>
            <h2 className="mb-1 font-medium">Column mapping</h2>
            <div className="grid max-w-2xl grid-cols-[10rem_1fr] items-center gap-1">
              {FIELDS.map((f) => (
                <Fragment key={f}>
                  <label className="font-mono">{f}</label>
                  <select
                    value={mapping[f] ?? ''}
                    onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })}
                    className="border border-neutral-400 px-1 py-0.5"
                  >
                    <option value="">—</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </Fragment>
              ))}
            </div>
            <button
              onClick={run}
              disabled={!canImport}
              className="mt-3 border border-neutral-400 bg-neutral-100 px-3 py-1 disabled:opacity-40"
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
            {!mapping.email && !mapping.linkedin_url && (
              <p className="mt-1 text-neutral-600">Map email or linkedin_url to continue.</p>
            )}
          </section>
        </>
      )}

      {result && (
        <section>
          <h2 className="mb-1 font-medium">Result</h2>
          <ul className="list-inside list-disc">
            <li>{result.new} new</li>
            <li>{result.duplicate} duplicates skipped</li>
            <li>{result.suppressed} suppressed skipped</li>
            <li>{result.malformed} malformed rejected</li>
          </ul>
          {result.errors.length > 0 && (
            <pre className="mt-2 max-w-2xl overflow-x-auto bg-neutral-100 p-2">
              {result.errors.join('\n')}
            </pre>
          )}
        </section>
      )}
    </div>
  )
}
