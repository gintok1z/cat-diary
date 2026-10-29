import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../lib/i18n'
import { FeedLogForm } from '../components/forms/FeedLogForm'
import { QuickActionModals } from '../components/layout/QuickActionModals'
import { useQuickActionStore } from '../stores/useQuickActionStore'
import type { InventoryItem } from '../types/database.types'

// Mock dependencies for QuickActionModals
vi.mock('../lib/auth', () => ({
    useSession: () => ({ user: { id: 'user-1' } }),
}))

vi.mock('../lib/useCat', () => ({
    useCat: () => ({ cat: { id: 'cat-1', name: '咪咪' }, catId: 'cat-1' }),
}))

vi.mock('../stores/useToastStore', () => ({
    useToastStore: (selector: (state: { pushToast: ReturnType<typeof vi.fn> }) => unknown) => selector({ pushToast: vi.fn() }),
}))

vi.mock('../lib/useOnlineStatus', () => ({
    useOnlineStatus: () => true,
}))

vi.mock('../lib/haptics', () => ({
    lightHaptic: vi.fn(),
}))

vi.mock('../lib/pushServer', () => ({
    sendDiaryNotification: vi.fn().mockResolvedValue(undefined),
    sendHealthNotification: vi.fn().mockResolvedValue(undefined),
}))

let mockInventoryData: InventoryItem[] = []
let realtimeCallback: (() => void) | null = null

vi.mock('../lib/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            if (table === 'inventory') {
                return {
                    select: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            order: vi.fn().mockImplementation(() => Promise.resolve({ data: [...mockInventoryData], error: null })),
                        }),
                    }),
                    insert: vi.fn().mockResolvedValue({ error: null }),
                    update: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ error: null }),
                    }),
                }
            }
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockResolvedValue({ data: [], error: null }),
                }),
            }
        }),
    },
}))

vi.mock('../lib/realtime', () => ({
    useRealtimeSubscription: vi.fn((table: string, cb: () => void) => {
        if (table === 'inventory') {
            realtimeCallback = cb
        }
    }),
}))

describe('Inventory Feed Sync', () => {
    beforeEach(() => {
        useQuickActionStore.getState().closeAction()
        mockInventoryData = [
            {
                id: 'inv-1',
                cat_id: 'cat-1',
                item_name: '渴望猫粮',
                icon: '🍗',
                status: 'plenty',
                total_quantity: 1000,
                daily_consumption: 50,
                unit: 'g',
                unit_ratio: 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            },
            {
                id: 'inv-2',
                cat_id: 'cat-1',
                item_name: '小李子罐头',
                icon: '🥫',
                status: 'plenty',
                total_quantity: 500,
                daily_consumption: 85,
                unit: 'g',
                unit_ratio: 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            },
        ]
        realtimeCallback = null
    })

    describe('FeedLogForm selectedItem reset on inventory deletion', () => {
        it('clears selected item if that item is removed from the inventory list', () => {
            const onSaveSuccess = vi.fn()
            const initialInventory: InventoryItem[] = [...mockInventoryData]

            const { rerender } = render(
                <LanguageProvider>
                    <FeedLogForm
                        catId="cat-1"
                        userId="user-1"
                        inventory={initialInventory}
                        onSaveSuccess={onSaveSuccess}
                    />
                </LanguageProvider>
            )

            // Select 渴望猫粮
            const itemBtn = screen.getByText('渴望猫粮')
            fireEvent.click(itemBtn)

            // Input amount
            const input = screen.getByRole('spinbutton')
            fireEvent.change(input, { target: { value: '45' } })
            expect((input as HTMLInputElement).value).toBe('45')

            // Now re-render with 渴望猫粮 removed from inventory
            const updatedInventory = initialInventory.filter((item) => item.id !== 'inv-1')
            rerender(
                <LanguageProvider>
                    <FeedLogForm
                        catId="cat-1"
                        userId="user-1"
                        inventory={updatedInventory}
                        onSaveSuccess={onSaveSuccess}
                    />
                </LanguageProvider>
            )

            // 渴望猫粮 should no longer be rendered
            expect(screen.queryByText('渴望猫粮')).toBeNull()
            // And input should be reset because selectedItem was cleared
            expect(screen.queryByRole('spinbutton')).toBeNull()
        })
    })

    describe('QuickActionModals dynamic inventory refetching on modal open', () => {
        it('re-fetches inventory and does NOT show deleted inventory when re-opening feed modal', async () => {
            render(
                <LanguageProvider>
                    <QuickActionModals />
                </LanguageProvider>
            )

            // 1. Open feed modal for the first time
            act(() => {
                useQuickActionStore.getState().openAction('feed')
            })

            await waitFor(() => {
                expect(screen.getByText('渴望猫粮')).toBeInTheDocument()
                expect(screen.getByText('小李子罐头')).toBeInTheDocument()
            })

            // 2. Close feed modal
            act(() => {
                useQuickActionStore.getState().closeAction()
            })

            // 3. Simulate inventory deletion in backend: 渴望猫粮 is deleted
            mockInventoryData = mockInventoryData.filter((i) => i.id !== 'inv-1')

            // 4. Re-open feed modal
            act(() => {
                useQuickActionStore.getState().openAction('feed')
            })

            // 5. Verify 渴望猫粮 is gone and 小李子罐头 is still there
            await waitFor(() => {
                expect(screen.queryByText('渴望猫粮')).toBeNull()
                expect(screen.getByText('小李子罐头')).toBeInTheDocument()
            })
        })

        it('updates inventory on realtime subscription trigger', async () => {
            render(
                <LanguageProvider>
                    <QuickActionModals />
                </LanguageProvider>
            )

            useQuickActionStore.getState().openAction('feed')

            await waitFor(() => {
                expect(screen.getByText('渴望猫粮')).toBeInTheDocument()
            })

            // Simulate deletion + Realtime event
            mockInventoryData = mockInventoryData.filter((i) => i.id !== 'inv-1')
            expect(realtimeCallback).not.toBeNull()
            realtimeCallback?.()

            await waitFor(() => {
                expect(screen.queryByText('渴望猫粮')).toBeNull()
            })
        })
    })
})
