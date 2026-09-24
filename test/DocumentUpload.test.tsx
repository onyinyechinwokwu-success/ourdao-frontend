import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DocumentUpload from '@/components/DocumentUpload'

function pinnedResponse(hash: string) {
  return { ok: true, status: 200, json: () => Promise.resolve({ hash }) } as Response
}

function selectFile(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['hello'], 'doc.txt', { type: 'text/plain' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('DocumentUpload access permissions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pinnedResponse('QmHash')))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('uploads an unencrypted document as closed unless public access is chosen', async () => {
    const onUpload = vi.fn()
    const { container } = render(<DocumentUpload onUpload={onUpload} />)
    selectFile(container)

    expect((screen.getByLabelText(/allow public access/i) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /upload 1 file/i }))

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1))
    expect(onUpload.mock.calls[0][0][0].permissions).toEqual({
      public: false,
      allowedUsers: [],
      allowedRoles: [],
    })
  })

  it('uploads an unencrypted document as public when the uploader opts in', async () => {
    const onUpload = vi.fn()
    const { container } = render(<DocumentUpload onUpload={onUpload} />)
    selectFile(container)

    fireEvent.click(screen.getByLabelText(/allow public access/i))
    fireEvent.click(screen.getByRole('button', { name: /upload 1 file/i }))

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1))
    expect(onUpload.mock.calls[0][0][0].permissions.public).toBe(true)
  })

  it('hides the permissions panel when showPermissions is false', () => {
    render(<DocumentUpload showPermissions={false} />)
    expect(screen.queryByLabelText(/allow public access/i)).toBeNull()
  })
})
