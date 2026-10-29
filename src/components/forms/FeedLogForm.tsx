import { useState, useMemo, useEffect } from 'react'
import type { FeedStatus, InventoryItem } from '../../types/database.types'
import {
    computeInventoryStatus,
    formatInventoryDisplay,
    roundQuantity,
} from '../../types/database.types'
import { calculateFeedGrams } from './formHelpers'
import { supabase } from '../../lib/supabase'
import { enqueueOp } from '../../lib/offlineQueue'
import { useI18n } from '../../lib/i18n'
import { useToastStore } from '../../stores/useToastStore'
import { getErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/Button'
import { EmptyStateCat } from '../ui/EmptyStateCat'
import { playMeowSound } from '../../lib/sound'

export interface FeedLogFormProps {
    catId: string
    userId: string
    inventory: InventoryItem[]
    onSaveSuccess: (optimisticFeed: FeedStatus, deductedGrams: number, inventoryId: string) => void
    onCancel?: () => void
}

export function FeedLogForm({
    catId,
    userId,
    inventory,
    onSaveSuccess,
    onCancel,
}: FeedLogFormProps) {
    const { language } = useI18n()
    const pushToast = useToastStore((s) => s.pushToast)

    const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null)
    const [inputMode, setInputMode] = useState<'unit' | 'grams'>('grams')
    const [amountValue, setAmountValue] = useState('')
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (selectedItem && !inventory.some((item) => item.id === selectedItem.id)) {
            setSelectedItem(null)
            setAmountValue('')
        }
    }, [inventory, selectedItem])

    const text = useMemo(() => language === 'zh'
        ? {
            chooseInventory: '选择库存物资',
            noInventory: '暂无库存物资，请先在统计页添加',
            amount: '喂食量',
            grams: '克 (g)',
            unmanagedStockHint: '此物资未设初始库存，记录后不扣减库存',
            remainingStock: (rem: number) => `扣减后剩余：${rem}g`,
            confirmFeed: '确认喂食 🐾',
            cancel: '取消',
            saving: '保存中...',
            feedSuccess: '喂食记录成功 🐾',
            feedOffline: '已离线暂存喂食记录，联网后自动同步 🐾',
            feedFail: '喂食记录失败，请稍后重试',
            quickAmount: '快捷选择',
            unitModeLabel: (u: string) => `按 ${u} 记录`,
            gramsModeLabel: '按 克(g) 记录',
            convertedHint: (g: number) => `≈ 换算为 ${g}g`,
        }
        : {
            chooseInventory: 'Choose item from inventory',
            noInventory: 'No inventory items yet. Add some on Stats page.',
            amount: 'Feeding amount',
            grams: 'grams (g)',
            unmanagedStockHint: 'No initial stock set for this item; stock will not be deducted.',
            remainingStock: (rem: number) => `Remaining after feed: ${rem}g`,
            confirmFeed: 'Confirm feeding 🐾',
            cancel: 'Cancel',
            saving: 'Saving...',
            feedSuccess: 'Feeding saved 🐾',
            feedOffline: 'Saved offline, will sync when reconnected 🐾',
            feedFail: 'Failed to save feeding. Please try again later.',
            quickAmount: 'Quick select',
            unitModeLabel: (u: string) => `By ${u}`,
            gramsModeLabel: 'By grams (g)',
            convertedHint: (g: number) => `≈ Converted to ${g}g`,
        }, [language])

    const hasCustomUnit = useMemo(() => {
        return Boolean(selectedItem?.unit && selectedItem.unit !== 'g' && (selectedItem.unit_ratio ?? 1) > 1)
    }, [selectedItem])

    const handleSelectInventoryItem = (item: InventoryItem) => {
        setSelectedItem(item)
        if (item.unit && item.unit !== 'g' && (item.unit_ratio ?? 1) > 1) {
            setInputMode('unit')
            setAmountValue('')
        } else {
            setInputMode('grams')
            setAmountValue('')
        }
    }

    const calculatedGrams = useMemo(() => {
        const val = parseFloat(amountValue)
        const ratio = selectedItem?.unit_ratio ?? 1
        return calculateFeedGrams(val, inputMode, ratio)
    }, [amountValue, inputMode, selectedItem])

    const handleSubmit = async () => {
        if (!catId || !userId || loading || !selectedItem) return
        if (calculatedGrams <= 0) return

        setLoading(true)
        const now = new Date().toISOString()
        const mealTypeValue = `${selectedItem.item_name}|${calculatedGrams}`

        const optimisticFeed: FeedStatus = {
            id: crypto.randomUUID(),
            cat_id: catId,
            status: 'fed',
            fed_by: userId,
            fed_at: now,
            meal_type: mealTypeValue,
            inventory_id: selectedItem.id,
            updated_at: now,
        }

        try {
            if (!navigator.onLine) {
                // Offline fallback
                await enqueueOp({
                    table: 'feed_status',
                    type: 'insert',
                    payload: {
                        cat_id: catId,
                        status: 'fed',
                        fed_by: userId,
                        fed_at: now,
                        meal_type: mealTypeValue,
                        inventory_id: selectedItem.id,
                    },
                })
                if (selectedItem.total_quantity != null) {
                    const newQty = Math.max(0, roundQuantity(selectedItem.total_quantity - calculatedGrams, 1))
                    const newStatus = computeInventoryStatus({
                        ...selectedItem,
                        total_quantity: newQty,
                    })
                    await enqueueOp({
                        table: 'inventory',
                        type: 'update',
                        payload: {
                            id: selectedItem.id,
                            total_quantity: newQty,
                            status: newStatus,
                            updated_by: userId,
                        },
                    })
                }
                pushToast('success', text.feedOffline)
            } else {
                // Online flow
                const { error: feedErr } = await supabase.from('feed_status').insert({
                    cat_id: catId,
                    status: 'fed' as const,
                    fed_by: userId,
                    fed_at: now,
                    meal_type: mealTypeValue,
                    inventory_id: selectedItem.id,
                })
                if (feedErr) throw feedErr

                // Deduct from inventory
                const { data: freshItem } = await supabase.from('inventory')
                    .select('total_quantity, daily_consumption')
                    .eq('id', selectedItem.id)
                    .single()
                const baseQty = freshItem?.total_quantity ?? selectedItem.total_quantity
                if (baseQty != null) {
                    const newQty = Math.max(0, roundQuantity(baseQty - calculatedGrams, 1))
                    const newStatus = computeInventoryStatus({
                        ...selectedItem,
                        total_quantity: newQty,
                        daily_consumption: freshItem?.daily_consumption ?? selectedItem.daily_consumption,
                    })
                    await supabase.from('inventory')
                        .update({ total_quantity: newQty, status: newStatus, updated_by: userId })
                        .eq('id', selectedItem.id)
                }
                pushToast('success', text.feedSuccess)
            }

            playMeowSound()
            onSaveSuccess(optimisticFeed, calculatedGrams, selectedItem.id)
        } catch (err) {
            pushToast('error', getErrorMessage(err, text.feedFail))
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="feed-form-flow" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {/* Inventory Selector */}
            <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                    {text.chooseInventory}
                </label>
                {inventory.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                        {inventory.map((item) => {
                            const isSelected = selectedItem?.id === item.id
                            const displayStock = formatInventoryDisplay(item.total_quantity ?? null, item.unit, item.unit_ratio ?? 1)
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => handleSelectInventoryItem(item)}
                                    className={`modal-option-btn ${isSelected ? 'active' : ''}`}
                                >
                                    <span>{item.icon || '📦'}</span>
                                    <span>{item.item_name}</span>
                                    {item.total_quantity != null && (
                                        <span style={{ opacity: 0.75, fontSize: '0.75rem' }}>({displayStock})</span>
                                    )}
                                </button>
                            )
                        })}
                    </div>
                ) : (
                    <EmptyStateCat posture="hungry_bowl" message={text.noInventory} />
                )}
            </div>

            {/* Amount and unit controls */}
            {selectedItem && (
                <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginBottom: 0 }}>
                    {hasCustomUnit && (
                        <div className="segment-toggle">
                            <button
                                type="button"
                                onClick={() => setInputMode('unit')}
                                className={`segment-toggle-btn ${inputMode === 'unit' ? 'active' : ''}`}
                            >
                                {text.unitModeLabel(selectedItem.unit || '份')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setInputMode('grams')}
                                className={`segment-toggle-btn ${inputMode === 'grams' ? 'active' : ''}`}
                            >
                                {text.gramsModeLabel}
                            </button>
                        </div>
                    )}

                    <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">
                            {text.amount} ({inputMode === 'unit' ? selectedItem.unit : text.grams})
                        </label>
                        <input
                            type="number"
                            step={inputMode === 'unit' ? '0.1' : '1'}
                            min="0"
                            className="form-input"
                            value={amountValue}
                            onChange={(e) => setAmountValue(e.target.value)}
                            placeholder="0"
                        />
                    </div>

                    {/* Conversion hint */}
                    {hasCustomUnit && inputMode === 'unit' && calculatedGrams > 0 && (
                        <div style={{ fontSize: '0.82rem', color: 'var(--color-primary)', fontWeight: 500 }}>
                            {text.convertedHint(calculatedGrams)}
                        </div>
                    )}

                    {/* Stock hint */}
                    {selectedItem.total_quantity == null ? (
                        <p className="text-xs text-muted" style={{ margin: 0 }}>
                            {text.unmanagedStockHint}
                        </p>
                    ) : (
                        <p className="text-xs text-muted" style={{ margin: 0 }}>
                            {text.remainingStock(Math.max(0, roundQuantity(selectedItem.total_quantity - calculatedGrams, 1)))}
                        </p>
                    )}
                </div>
            )}

            {/* Submit buttons */}
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
                {onCancel && (
                    <Button variant="ghost" fullWidth onClick={onCancel} disabled={loading}>
                        {text.cancel}
                    </Button>
                )}
                <Button
                    variant="primary"
                    fullWidth
                    onClick={handleSubmit}
                    disabled={loading || !selectedItem || calculatedGrams <= 0}
                >
                    {loading ? text.saving : text.confirmFeed}
                </Button>
            </div>
        </div>
    )
}
