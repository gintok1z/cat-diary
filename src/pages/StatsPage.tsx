import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'
import { Modal } from '../components/ui/Modal'
import { RenewModal } from '../components/ui/RenewModal'
import { SwipeableRow } from '../components/ui/SwipeableRow'
import { EmptyCatIllustration } from '../components/ui/EmptyCatIllustration'
import { Skeleton } from '../components/ui/Skeleton'
import { supabase } from '../lib/supabase'
import { useSession } from '../lib/auth'
import { useCat } from '../lib/useCat'
import { useToastStore } from '../stores/useToastStore'
import { getErrorMessage } from '../lib/errorMessage'
import { lightHaptic } from '../lib/haptics'
import { useOnlineStatus } from '../lib/useOnlineStatus'
import { useRenewForm } from '../lib/useRenewForm'
import { sendHealthNotification } from '../lib/pushServer'
import { isAbnormalPoop, INVENTORY_ICONS, STORAGE_KEYS } from '../lib/constants'
import { useRealtimeSubscription } from '../lib/realtime'
import { useI18n } from '../lib/i18n'
import { format } from 'date-fns'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'
import type { WeightRecord, HealthRecord, InventoryItem, InventoryStatus, PoopLog, MissLog, FeedStatus, DiaryEntry, MoodLog, InventoryExpiryReminder } from '../types/database.types'
import { computeInventoryExpiryHoursLeft, computeInventoryStatus, roundQuantity, formatInventoryDisplay, gramsToUnit, unitToGrams } from '../types/database.types'
import { SnoozedAlertsDropdown } from '../components/stats/SnoozedAlertsDropdown'
import './StatsPage.css'

type ChartType = 'weight' | 'poop' | 'miss' | 'feed' | 'inventoryFeed'
type HealthFormType = 'vaccine' | 'deworming' | 'medical' | 'vomit'
type ExportTypeKey = 'weight' | 'poop' | 'miss' | 'health' | 'inventory' | 'diary' | 'mood' | 'feed'

/** Escape HTML special characters to prevent XSS in exported reports. */
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

/** Health type icons (labels are translated at runtime). */
const HEALTH_TYPE_ICONS: Record<HealthFormType, string> = {
    vaccine: '💉',
    deworming: '💊',
    medical: '🏥',
    vomit: '🤮',
}

/** Pie chart colors (module-level constant). */
const PIE_COLORS = ['var(--color-primary)', 'var(--color-secondary)', 'var(--color-accent)', 'var(--color-success)', 'var(--color-warning)', 'var(--color-danger)', 'var(--color-primary-dark)']

/** Health category display order (module-level constant). */
const CATEGORY_ORDER: HealthFormType[] = ['vaccine', 'deworming', 'medical', 'vomit']

/** Shared Recharts style constants. */
const CHART_TICK_STYLE = { fill: 'var(--color-text-secondary)', fontSize: 12 }
const CHART_TICK_STYLE_SM = { fill: 'var(--color-text-secondary)', fontSize: 11 }
const CHART_TOOLTIP_STYLE = { background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '13px' }
const CHART_GRID_STROKE = 'rgba(255,255,255,0.08)'
const CHART_AXIS_STROKE = 'rgba(255,255,255,0.1)'
const LEGEND_STYLE = { fontSize: 12 }
const WEIGHT_DOT = { fill: 'var(--color-primary)', r: 4 }
const WEIGHT_ACTIVE_DOT = { r: 6 }
const MISS_DOT = { fill: 'var(--color-accent)', r: 3 }
const MISS_ACTIVE_DOT = { r: 5 }
const FEED_DOT = { fill: 'var(--color-secondary)', r: 3 }
const FEED_ACTIVE_DOT = { r: 5 }

export function StatsPage() {
    const { user } = useSession()
    const { language } = useI18n()
    const l = useCallback((zh: string, en: string) => (language === 'zh' ? zh : en), [language])
    const { cat, catId, loading: catLoading } = useCat()
    const pushToast = useToastStore((s) => s.pushToast)
    const online = useOnlineStatus()
    const [searchParams, setSearchParams] = useSearchParams()
    const text = useMemo(() => language === 'zh'
        ? {
            title: '📊 统计',
            subtitle: '健康数据与库存管理',
            exportAll: '导出全部记录',
            weightTrend: '⚖️ 体重趋势',
            add: '+ 添加',
            rangeLabel: (days: number) => `趋势区间：近 ${days} 天`,
            dateFrom: '起始日期',
            dateTo: '结束日期',
            weightName: '体重',
            currentWeight: (weight: number) => `当前体重：${weight} kg，再记一次就能看趋势图了`,
            noWeight: '还没有体重记录，去记录页添加吧',
            poopDistribution: '🧻 便便分布',
            noPoop: '该时间段暂无便便记录',
            missCount: '🥹 咪被想次数',
            missCountName: '咪被想次数',
            feedCount: '🍽️ 喂食次数',
            feedCountName: '喂食次数',
            setDefault: '设为默认',
            defaultSet: '已设为默认',
        }
        : {
            title: '📊 Stats',
            subtitle: 'Health data and inventory management',
            exportAll: 'Export all records',
            weightTrend: '⚖️ Weight Trend',
            add: '+ Add',
            rangeLabel: (days: number) => `Range: last ${days} days`,
            dateFrom: 'Start date',
            dateTo: 'End date',
            weightName: 'Weight',
            currentWeight: (weight: number) => `Current weight: ${weight} kg. Add one more to view the trend chart.`,
            noWeight: 'No weight records yet. Add one from Logs.',
            poopDistribution: '🧻 Poop Distribution',
            noPoop: 'No poop records in this range',
            missCount: '🥹 Missing-you Count',
            missCountName: 'Missing-you count',
            feedCount: '🍽️ Feeding Count',
            feedCountName: 'Feeding count',
            setDefault: 'Set default',
            defaultSet: 'Default set',
        }, [language])

    const [weights, setWeights] = useState<WeightRecord[]>([])
    const [healthRecords, setHealthRecords] = useState<HealthRecord[]>([])
    const [inventory, setInventory] = useState<InventoryItem[]>([])
    const [inventoryExpiryReminders, setInventoryExpiryReminders] = useState<InventoryExpiryReminder[]>([])
    const [poops, setPoops] = useState<PoopLog[]>([])
    const [missLogs, setMissLogs] = useState<MissLog[]>([])
    const [feeds, setFeeds] = useState<FeedStatus[]>([])
    const [loading, setLoading] = useState(true)
    const [collapsedCategories, setCollapsedCategories] = useState<Set<HealthFormType>>(new Set(['vaccine', 'deworming', 'medical', 'vomit']))
    const [chartType, setChartType] = useState<ChartType>(() => {
        const stored = localStorage.getItem(STORAGE_KEYS.DEFAULT_CHART_TYPE)
        if (stored && ['weight', 'poop', 'miss', 'feed', 'inventoryFeed'].includes(stored)) return stored as ChartType
        return 'weight'
    })
    const [feedStatMode, setFeedStatMode] = useState<'grams' | 'count'>('grams')
    const [pendingStopRecord, setPendingStopRecord] = useState<HealthRecord | null>(null)

    // Modals
    const [healthModalOpen, setHealthModalOpen] = useState(false)
    const [healthType, setHealthType] = useState<HealthFormType>('vaccine')
    const [healthName, setHealthName] = useState('')
    const [healthDate, setHealthDate] = useState(format(new Date(), 'yyyy-MM-dd'))
    const [healthNextDue, setHealthNextDue] = useState('')
    const [healthMedicalPreset, setHealthMedicalPreset] = useState<'vomit' | 'cough' | 'fever' | 'other'>('vomit')
    const [healthNotes, setHealthNotes] = useState('')
    const [editingHealthId, setEditingHealthId] = useState<string | null>(null)
    const [healthSaving, setHealthSaving] = useState(false)

    // Renew modal (vaccine / deworming) — shared hook
    // Use arrow wrapper to avoid forward-reference of loadData
    const renew = useRenewForm({ catId, onSuccess: () => loadData() })

    const [inventoryModalOpen, setInventoryModalOpen] = useState(false)
    const [invItemName, setInvItemName] = useState('')
    const [invIcon, setInvIcon] = useState<string | null>(null)
    const [invUnit, setInvUnit] = useState('g')
    const [invUnitRatio, setInvUnitRatio] = useState('1')
    const [isCustomInvUnit, setIsCustomInvUnit] = useState(false)
    const [invTotalQty, setInvTotalQty] = useState('')
    const [invAlertThreshold, setInvAlertThreshold] = useState('')
    const [editingInvId, setEditingInvId] = useState<string | null>(null)
    const [invSaving, setInvSaving] = useState(false)

    const [expiryModalOpen, setExpiryModalOpen] = useState(false)
    const [expiryItemName, setExpiryItemName] = useState('')
    const [expiryInHours, setExpiryInHours] = useState('')
    const [expirySaving, setExpirySaving] = useState(false)
    const [discardingExpiryId, setDiscardingExpiryId] = useState<string | null>(null)

    const [weightModalOpen, setWeightModalOpen] = useState(false)
    const [weightValue, setWeightValue] = useState('')
    const [weightDate, setWeightDate] = useState(format(new Date(), 'yyyy-MM-dd'))
    const [chartStartDate, setChartStartDate] = useState(() => {
        const d = new Date()
        d.setDate(d.getDate() - 29)
        return format(d, 'yyyy-MM-dd')
    })
    const [chartEndDate, setChartEndDate] = useState(() => format(new Date(), 'yyyy-MM-dd'))
    const [weightError, setWeightError] = useState('')
    const [editingWeightId, setEditingWeightId] = useState<string | null>(null)
    const [weightSaving, setWeightSaving] = useState(false)
    const [pendingDelete, setPendingDelete] = useState<{ id: string; type: 'health' | 'inventory' | 'weight' } | null>(null)
    const [deleteSubmitting, setDeleteSubmitting] = useState(false)
    const [vetReportLangModalOpen, setVetReportLangModalOpen] = useState(false)
    const [exportModalOpen, setExportModalOpen] = useState(false)
    const [exportDays, setExportDays] = useState(30)
    const [exporting, setExporting] = useState(false)
    const [exportTypes, setExportTypes] = useState<Record<ExportTypeKey, boolean>>({
        weight: true,
        poop: true,
        miss: true,
        health: true,
        inventory: true,
        diary: true,
        mood: true,
        feed: true,
    })

    const maxExportDays = useMemo(() => {
        if (!cat?.created_at) return 1
        const created = new Date(cat.created_at)
        const now = new Date()
        created.setHours(0, 0, 0, 0)
        now.setHours(0, 0, 0, 0)
        const diffDays = Math.floor((now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000)) + 1
        return Math.max(1, diffDays)
    }, [cat?.created_at])

    useEffect(() => {
        setExportDays((prev) => Math.min(Math.max(prev, 1), maxExportDays))
    }, [maxExportDays])

    // ─── Quick-open from URL params ───────────────
    useEffect(() => {
        const quick = searchParams.get('quick')
        if (!quick || loading) return
        if (quick === 'inventory') {
            setInventoryModalOpen(true)
            setSearchParams({}, { replace: true })
        } else if (quick === 'health') {
            setHealthModalOpen(true)
            setSearchParams({}, { replace: true })
        } else if (quick === 'expiry') {
            resetExpiryForm()
            setExpiryModalOpen(true)
            setSearchParams({}, { replace: true })
        } else if (quick === 'vetreport') {
            setVetReportLangModalOpen(true)
            setSearchParams({}, { replace: true })
        } else if (quick === 'export') {
            setExportModalOpen(true)
            setSearchParams({}, { replace: true })
        }
    }, [searchParams, setSearchParams, loading])

    // ─── Load data ────────────────────────────────
    const loadData = useCallback(async () => {
        if (!catId) {
            if (!catLoading) setLoading(false)
            return
        }

        try {
            const [w, h, inv, invExpiry, poopData, missData, feedData] = await Promise.all([
                supabase.from('weight_records').select('*').eq('cat_id', catId).order('recorded_at', { ascending: true }),
                supabase.from('health_records').select('*').eq('cat_id', catId).order('date', { ascending: false }),
                supabase.from('inventory').select('*').eq('cat_id', catId).order('item_name', { ascending: true }),
                supabase
                    .from('inventory_expiry_reminders')
                    .select('*')
                    .eq('cat_id', catId)
                    .is('discarded_at', null)
                    .order('expires_at', { ascending: true }),
                supabase.from('poop_logs').select('*').eq('cat_id', catId).order('created_at', { ascending: false }).limit(120),
                supabase.from('miss_logs').select('*').eq('cat_id', catId).order('created_at', { ascending: false }).limit(200),
                supabase.from('feed_status').select('*').eq('cat_id', catId).order('fed_at', { ascending: false }).limit(400),
            ])

            if (w.data) setWeights(w.data)
            if (h.data) setHealthRecords(h.data)
            if (inv.data) setInventory(inv.data)
            if (invExpiry.data) setInventoryExpiryReminders(invExpiry.data)
            if (poopData.data) setPoops(poopData.data)
            if (missData.data) setMissLogs(missData.data)
            if (feedData.data) setFeeds(feedData.data)
        } catch (err) {
            console.error('Failed to load stats data:', err)
            pushToast('error', getErrorMessage(err, l('统计数据加载失败，请稍后重试', 'Failed to load stats data, please try again later')))
        } finally {
            setLoading(false)
        }
    }, [catId, catLoading, l, pushToast])

    useEffect(() => { loadData() }, [loadData])

    // ─── Realtime subscription for feed_status ─────
    const reloadFeeds = useCallback(async () => {
        if (!catId) return
        const { data } = await supabase.from('feed_status').select('*').eq('cat_id', catId).order('fed_at', { ascending: false }).limit(400)
        if (data) setFeeds(data)
    }, [catId])
    useRealtimeSubscription('feed_status', () => { reloadFeeds() })

    // ─── Realtime subscription for inventory ───────
    const reloadInventory = useCallback(async () => {
        if (!catId) return
        const { data } = await supabase.from('inventory').select('*').eq('cat_id', catId).order('item_name', { ascending: true })
        if (data) setInventory(data)
    }, [catId])
    useRealtimeSubscription('inventory', () => { reloadInventory() })

    // ─── Chart date range cutoffs (memoized) ───────
    const chartStartTs = useMemo(() => new Date(`${chartStartDate}T00:00:00`).getTime(), [chartStartDate])
    const chartEndTs = useMemo(() => new Date(`${chartEndDate}T23:59:59.999`).getTime(), [chartEndDate])

    // ─── Weight chart data (memoized) ───────────────
    const chartData = useMemo(() => {
        return weights
            .filter((w) => {
                const t = new Date(w.recorded_at).getTime()
                return t >= chartStartTs && t <= chartEndTs
            })
            .map((w) => ({
                date: format(new Date(w.recorded_at), 'MM/dd'),
                weight: w.weight_kg,
            }))
    }, [chartStartTs, chartEndTs, weights])

    const bristolDistributionData = useMemo(() => {
        const counts = {
            [l('正常', 'Normal')]: 0,
            [l('异常', 'Abnormal')]: 0,
        }
        poops.forEach((item) => {
            const t = new Date(item.created_at).getTime()
            if (t >= chartStartTs && t <= chartEndTs) {
                if (isAbnormalPoop(item.bristol_type, item.color)) {
                    counts[l('异常', 'Abnormal')] += 1
                } else {
                    counts[l('正常', 'Normal')] += 1
                }
            }
        })

        return Object.entries(counts)
            .map(([name, value]) => ({ name, value }))
            .filter((item) => item.value > 0)
    }, [l, poops, chartStartTs, chartEndTs])

    const missTrendData = useMemo(() => {
        const dayMap = new Map<string, number>()
        const start = new Date(`${chartStartDate}T00:00:00`)
        const end = new Date(`${chartEndDate}T23:59:59`)
        const diffDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)))
        for (let i = 0; i <= diffDays; i++) {
            const d = new Date(start)
            d.setDate(d.getDate() + i)
            const key = format(d, 'MM/dd')
            dayMap.set(key, 0)
        }

        missLogs.forEach((item) => {
            const t = new Date(item.created_at).getTime()
            if (t >= chartStartTs && t <= chartEndTs) {
                const key = format(new Date(item.created_at), 'MM/dd')
                if (dayMap.has(key)) {
                    dayMap.set(key, (dayMap.get(key) || 0) + 1)
                }
            }
        })

        return Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }))
    }, [missLogs, chartStartDate, chartEndDate, chartStartTs, chartEndTs])

    const feedTrendData = useMemo(() => {
        const dayMap = new Map<string, number>()
        const start = new Date(`${chartStartDate}T00:00:00`)
        const end = new Date(`${chartEndDate}T23:59:59`)
        const diffDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)))
        for (let i = 0; i <= diffDays; i++) {
            const d = new Date(start)
            d.setDate(d.getDate() + i)
            const key = format(d, 'MM/dd')
            dayMap.set(key, 0)
        }

        feeds.forEach((item) => {
            const at = item.fed_at || item.updated_at
            const t = new Date(at).getTime()
            if (t >= chartStartTs && t <= chartEndTs) {
                const key = format(new Date(at), 'MM/dd')
                if (dayMap.has(key)) {
                    dayMap.set(key, (dayMap.get(key) || 0) + 1)
                }
            }
        })

        return Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }))
    }, [feeds, chartStartDate, chartEndDate, chartStartTs, chartEndTs])

    const inventoryFeedData = useMemo(() => {
        const dataMap = new Map<string, number>()
        feeds.forEach((f) => {
            const at = f.fed_at || f.updated_at
            const t = new Date(at).getTime()
            if (t >= chartStartTs && t <= chartEndTs) {
                const parts = f.meal_type.split('|')
                const itemName = parts[0]
                if (itemName) {
                    if (feedStatMode === 'grams') {
                        const grams = parts[1] ? parseFloat(parts[1]) : 0
                        if (!isNaN(grams)) {
                            dataMap.set(itemName, roundQuantity((dataMap.get(itemName) || 0) + grams, 1))
                        }
                    } else {
                        dataMap.set(itemName, (dataMap.get(itemName) || 0) + 1)
                    }
                }
            }
        })
        return Array.from(dataMap.entries())
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
    }, [feeds, chartStartTs, chartEndTs, feedStatMode])

    const chartDaysSpan = useMemo(() => Math.max(1, Math.ceil((chartEndTs - chartStartTs) / (24 * 60 * 60 * 1000))), [chartStartTs, chartEndTs])

    const chartTypeOptions: { value: ChartType; label: string }[] = useMemo(() => [
        { value: 'weight', label: text.weightTrend },
        { value: 'poop', label: text.poopDistribution },
        { value: 'miss', label: text.missCount },
        { value: 'feed', label: text.feedCount },
        { value: 'inventoryFeed', label: l('📊 库存喂食统计', '📊 Feed by Inventory') },
    ], [text, l])

    const expiryPreviewDateTime = useMemo(() => {
        const hours = Math.floor(Number(expiryInHours))
        if (!Number.isFinite(hours) || hours <= 0) return null
        const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000)
        return format(expiresAt, 'yyyy/MM/dd HH:mm')
    }, [expiryInHours])

    const isDefaultChart = localStorage.getItem(STORAGE_KEYS.DEFAULT_CHART_TYPE) === chartType
    const handleSetDefaultChart = () => {
        localStorage.setItem(STORAGE_KEYS.DEFAULT_CHART_TYPE, chartType)
        lightHaptic()
        pushToast('success', text.defaultSet)
    }

    const handleToggleExportType = (key: ExportTypeKey) => {
        setExportTypes((prev) => ({ ...prev, [key]: !prev[key] }))
    }

    const exportSelectedRecords = async () => {
        if (!catId) return
        const selectedTypes = (Object.keys(exportTypes) as ExportTypeKey[]).filter((k) => exportTypes[k])
        if (selectedTypes.length === 0) {
            pushToast('error', l('请至少选择一种导出类型', 'Please select at least one export type'))
            return
        }

        const cutoff = Date.now() - (exportDays - 1) * 24 * 60 * 60 * 1000
        const cutoffIso = new Date(cutoff).toISOString()
        setExporting(true)

        try {
            const [weightsRes, poopsRes, missesRes, healthRes, invRes, diaryRes, moodRes, feedRes] = await Promise.all([
                exportTypes.weight
                    ? supabase.from('weight_records').select('*').eq('cat_id', catId).gte('recorded_at', cutoffIso).order('recorded_at', { ascending: true })
                    : Promise.resolve({ data: [] as WeightRecord[], error: null }),
                exportTypes.poop
                    ? supabase.from('poop_logs').select('*').eq('cat_id', catId).gte('created_at', cutoffIso).order('created_at', { ascending: true })
                    : Promise.resolve({ data: [] as PoopLog[], error: null }),
                exportTypes.miss
                    ? supabase.from('miss_logs').select('*').eq('cat_id', catId).gte('created_at', cutoffIso).order('created_at', { ascending: true })
                    : Promise.resolve({ data: [] as MissLog[], error: null }),
                exportTypes.health
                    ? supabase.from('health_records').select('*').eq('cat_id', catId).gte('date', format(new Date(cutoff), 'yyyy-MM-dd')).order('date', { ascending: true })
                    : Promise.resolve({ data: [] as HealthRecord[], error: null }),
                exportTypes.inventory
                    ? supabase.from('inventory').select('*').eq('cat_id', catId).order('item_name', { ascending: true })
                    : Promise.resolve({ data: [] as InventoryItem[], error: null }),
                exportTypes.diary
                    ? supabase.from('diary_entries').select('*').eq('cat_id', catId).gte('created_at', cutoffIso).order('created_at', { ascending: true })
                    : Promise.resolve({ data: [] as DiaryEntry[], error: null }),
                exportTypes.mood
                    ? supabase.from('mood_logs').select('*').eq('cat_id', catId).gte('created_at', cutoffIso).order('created_at', { ascending: true })
                    : Promise.resolve({ data: [] as MoodLog[], error: null }),
                exportTypes.feed
                    ? supabase.from('feed_status').select('*').eq('cat_id', catId).gte('fed_at', cutoffIso).order('fed_at', { ascending: true })
                    : Promise.resolve({ data: [] as FeedStatus[], error: null }),
            ])

            const noRecord = `<li>${escapeHtml(l('暂无记录', 'No records'))}</li>`
            const htmlSections: string[] = []
            if (exportTypes.weight) htmlSections.push(`<h2>${escapeHtml(l('⚖️ 体重记录', '⚖️ Weight Records'))}</h2><ul>${(weightsRes.data || []).map((w) => `<li>${escapeHtml(new Date(w.recorded_at).toLocaleString())}: ${escapeHtml(String(w.weight_kg))} kg</li>`).join('') || noRecord}</ul>`)
            if (exportTypes.poop) htmlSections.push(`<h2>${escapeHtml(l('💩 便便记录', '💩 Poop Records'))}</h2><ul>${(poopsRes.data || []).map((p) => `<li>${escapeHtml(new Date(p.created_at).toLocaleString())}: Bristol ${escapeHtml(String(p.bristol_type))}, ${escapeHtml(p.color)}</li>`).join('') || noRecord}</ul>`)
            if (exportTypes.miss) htmlSections.push(`<h2>${escapeHtml(l('🥹 咪被想次数', '🥹 Missing-you Records'))}</h2><ul>${(missesRes.data || []).map((m) => `<li>${escapeHtml(new Date(m.created_at).toLocaleString())}</li>`).join('') || noRecord}</ul>`)
            if (exportTypes.health) htmlSections.push(`<h2>${escapeHtml(l('💉 健康记录', '💉 Health Records'))}</h2><ul>${(healthRes.data || []).map((h) => `<li>${escapeHtml(new Date(h.date).toLocaleDateString())}: ${escapeHtml(h.name)} (${escapeHtml(h.type)})${h.notes ? ` - ${escapeHtml(h.notes)}` : ''}</li>`).join('') || noRecord}</ul>`)
            if (exportTypes.inventory) htmlSections.push(`<h2>${escapeHtml(l('📦 物资库存', '📦 Inventory'))}</h2><ul>${(invRes.data || []).map((i) => `<li>${escapeHtml(i.item_name)}${i.icon ? ` ${escapeHtml(i.icon)}` : ''}: ${escapeHtml(i.status)}</li>`).join('') || noRecord}</ul>`)
            if (exportTypes.diary) htmlSections.push(`<h2>${escapeHtml(l('📝 日记', '📝 Diary'))}</h2><ul>${(diaryRes.data || []).map((d) => `<li><div>${escapeHtml(new Date(d.created_at).toLocaleString())}: ${escapeHtml(d.text || l('(无文字)', '(No text)'))}</div>${d.image_url ? `<div style="margin-top:6px;"><img src="${escapeHtml(d.image_url)}" alt="diary image" style="max-width:100%;max-height:360px;object-fit:contain;border-radius:8px;border:1px solid #ddd;" /></div>` : ''}</li>`).join('') || noRecord}</ul>`)
            if (exportTypes.mood) htmlSections.push(`<h2>${escapeHtml(l('😺 心情', '😺 Mood'))}</h2><ul>${(moodRes.data || []).map((m) => `<li>${escapeHtml(m.date)}: ${escapeHtml(m.mood)}</li>`).join('') || noRecord}</ul>`)
            if (exportTypes.feed) htmlSections.push(`<h2>${escapeHtml(l('🍽️ 喂食', '🍽️ Feeding'))}</h2><ul>${(feedRes.data || []).map((f) => { const parts = f.meal_type.split('|'); const name = parts[0]; const grams = parts[1] ? ` ${parts[1]}g` : ''; return `<li>${escapeHtml(new Date(f.fed_at || f.updated_at).toLocaleString())}: ${escapeHtml(name)}${escapeHtml(grams)}</li>` }).join('') || noRecord}</ul>`)

            const html = `
            <html><head><meta charset="utf-8" /><title>${escapeHtml(l('记录导出', 'Record Export'))}</title>
            <style>body{font-family:-apple-system;padding:24px;line-height:1.6}h1{margin:0 0 4px}h2{margin:20px 0 8px}ul{padding-left:18px}</style>
            </head><body>
            <h1>${escapeHtml(l('🐱 全部记录导出', '🐱 Full Record Export'))}</h1>
            <div>${escapeHtml(l(`时间跨度：最近 ${exportDays} 天`, `Range: last ${exportDays} days`))}</div>
            ${htmlSections.join('')}
            </body></html>`

            const iframe = document.createElement('iframe')
            iframe.style.position = 'fixed'
            iframe.style.right = '0'
            iframe.style.bottom = '0'
            iframe.style.width = '0'
            iframe.style.height = '0'
            iframe.style.border = '0'
            iframe.setAttribute('aria-hidden', 'true')
            document.body.appendChild(iframe)

            const cleanup = () => setTimeout(() => iframe.remove(), 1500)

            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document
                if (!doc || !iframe.contentWindow) throw new Error('print-frame-unavailable')
                doc.open()
                doc.write(html)
                doc.close()
                const runPrint = () => {
                    iframe.contentWindow?.focus()
                    iframe.contentWindow?.print()
                    cleanup()
                }
                if (doc.readyState === 'complete') runPrint()
                else iframe.onload = runPrint
            } catch {
                cleanup()
                const reportWindow = window.open('', '_blank')
                if (!reportWindow) {
                    pushToast('error', l('导出窗口被拦截，请允许弹窗后重试', 'Export popup was blocked. Please allow popups and try again'))
                    return
                }
                reportWindow.document.write(html)
                reportWindow.document.close()
                reportWindow.focus()
                reportWindow.print()
            }

            setExportModalOpen(false)
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('导出失败，请稍后重试', 'Export failed, please try again later')))
        } finally {
            setExporting(false)
        }
    }

    // ─── Save health record ───────────────────────
    const handleHealthSave = async () => {
        if (!catId || !user || !healthName.trim()) return
        setHealthSaving(true)
        try {
            const payloadType = healthType === 'vomit' ? 'medical' : healthType
            const payloadName = healthType === 'vomit' ? l('呕吐', 'Vomit') : healthName.trim()
            const payloadNextDue = payloadType === 'medical' ? null : (healthNextDue || null)
            if (editingHealthId) {
                await supabase
                    .from('health_records')
                    .update({
                        type: payloadType,
                        name: payloadName,
                        date: healthDate,
                        next_due: payloadNextDue,
                        notes: healthNotes.trim() || null,
                    })
                    .eq('id', editingHealthId)
            } else {
                await supabase.from('health_records').insert({
                    cat_id: catId,
                    type: payloadType,
                    name: payloadName,
                    date: healthDate,
                    next_due: payloadNextDue,
                    notes: healthNotes.trim() || null,
                    created_by: user.id,
                })
            }
            setHealthModalOpen(false)
            resetHealthForm()
            await loadData()
            lightHaptic()
            pushToast('success', editingHealthId ? l('健康记录已更新', 'Health record updated') : l('健康记录已保存', 'Health record saved'))
            if (!editingHealthId && catId) {
                const typeLabel = healthType === 'vomit'
                    ? l('呕吐', 'Vomit')
                    : healthType === 'vaccine'
                        ? l('疫苗', 'Vaccine')
                        : healthType === 'deworming'
                            ? l('驱虫', 'Deworming')
                            : l('就医', 'Medical')
                sendHealthNotification(catId, cat?.name || l('猫咪', 'Cat'), typeLabel, payloadName).catch(() => { })
            }
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('健康记录保存失败，请稍后重试', 'Failed to save health record, please try again later')))
        } finally {
            setHealthSaving(false)
        }
    }

    const resetHealthForm = () => {
        setHealthName('')
        setHealthDate(format(new Date(), 'yyyy-MM-dd'))
        setHealthNextDue('')
        setHealthMedicalPreset('other')
        setHealthNotes('')
        setHealthType('vaccine')
        setEditingHealthId(null)
    }

    // ─── Save/update inventory ────────────────────
    const handleInventorySave = async () => {
        if (!catId || !user || !invItemName.trim()) return
        const finalUnit = isCustomInvUnit ? invUnit.trim() : invUnit
        if (isCustomInvUnit && !finalUnit) {
            pushToast('error', l('请输入自定义单位名称', 'Please enter a custom unit name'))
            return
        }
        const ratio = parseFloat(invUnitRatio) > 0 ? parseFloat(invUnitRatio) : 1
        const rawTotal = invTotalQty ? parseFloat(invTotalQty) : null
        const rawThreshold = invAlertThreshold ? parseFloat(invAlertThreshold) : null

        // Convert custom unit quantities to base grams for persistent database storage
        const totalGrams = rawTotal != null ? (finalUnit !== 'g' && ratio > 1 ? unitToGrams(rawTotal, ratio) : rawTotal) : null
        const thresholdGrams = rawThreshold != null ? (finalUnit !== 'g' && ratio > 1 ? unitToGrams(rawThreshold, ratio) : rawThreshold) : null

        // Compute status from grams vs threshold grams
        const fakeItem = { total_quantity: totalGrams, daily_consumption: thresholdGrams, status: 'plenty' as InventoryStatus } as InventoryItem
        const status = computeInventoryStatus(fakeItem)
        setInvSaving(true)
        try {
            if (editingInvId) {
                await supabase.from('inventory')
                    .update({
                        item_name: invItemName.trim(),
                        icon: invIcon,
                        status,
                        total_quantity: totalGrams,
                        daily_consumption: thresholdGrams,
                        unit: finalUnit || 'g',
                        unit_ratio: ratio,
                        updated_by: user.id,
                    })
                    .eq('id', editingInvId)
            } else {
                await supabase.from('inventory').insert({
                    cat_id: catId,
                    item_name: invItemName.trim(),
                    icon: invIcon,
                    status,
                    total_quantity: totalGrams,
                    daily_consumption: thresholdGrams,
                    unit: finalUnit || 'g',
                    unit_ratio: ratio,
                    updated_by: user.id,
                    updated_at: new Date().toISOString(),
                })
            }
            setInventoryModalOpen(false)
            resetInvForm()
            await loadData()
            lightHaptic()
            pushToast('success', l('库存已更新', 'Inventory updated'))
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('库存保存失败，请稍后重试', 'Failed to save inventory, please try again later')))
        } finally {
            setInvSaving(false)
        }
    }

    const resetInvForm = () => {
        setInvItemName('')
        setInvIcon(null)
        setInvUnit('g')
        setInvUnitRatio('1')
        setIsCustomInvUnit(false)
        setInvTotalQty('')
        setInvAlertThreshold('')
        setEditingInvId(null)
    }

    const resetExpiryForm = () => {
        setExpiryItemName('')
        setExpiryInHours('')
    }

    const handleExpiryReminderSave = async () => {
        if (!catId || !user || !expiryItemName.trim()) return

        const hours = Math.floor(Number(expiryInHours))
        if (!Number.isFinite(hours) || hours <= 0) {
            pushToast('error', l('请填写大于 0 的过期小时数', 'Please enter an expiry hour value greater than 0'))
            return
        }

        const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000)

        setExpirySaving(true)
        try {
            const { error } = await supabase.from('inventory_expiry_reminders').insert({
                cat_id: catId,
                item_name: expiryItemName.trim(),
                expires_at: expiresAt.toISOString(),
                created_by: user.id,
            })
            if (error) throw error

            setExpiryModalOpen(false)
            resetExpiryForm()
            await loadData()
            lightHaptic()
            pushToast('success', l('过期提醒已添加', 'Expiry reminder added'))
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('过期提醒保存失败，请稍后重试', 'Failed to save expiry reminder, please try again later')))
        } finally {
            setExpirySaving(false)
        }
    }

    const markExpiryReminderDiscarded = async (id: string) => {
        setDiscardingExpiryId(id)
        try {
            const { error } = await supabase
                .from('inventory_expiry_reminders')
                .update({ discarded_at: new Date().toISOString() })
                .eq('id', id)
            if (error) throw error

            lightHaptic()
            pushToast('success', l('已标记为已丢弃', 'Marked as discarded'))
            await loadData()
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('操作失败，请稍后重试', 'Action failed, please try again later')))
        } finally {
            setDiscardingExpiryId(null)
        }
    }

    const resetWeightForm = () => {
        setWeightValue('')
        setWeightDate(format(new Date(), 'yyyy-MM-dd'))
        setEditingWeightId(null)
    }

    const openEditInventory = (item: InventoryItem) => {
        setEditingInvId(item.id)
        setInvItemName(item.item_name)
        setInvIcon(item.icon || null)
        const unit = item.unit || 'g'
        const ratio = item.unit_ratio ?? 1
        const isPreset = ['g', '罐', '袋', '支', '包'].includes(unit)
        setIsCustomInvUnit(!isPreset)
        setInvUnit(unit)
        setInvUnitRatio(String(ratio))
        if (unit !== 'g' && ratio > 1) {
            setInvTotalQty(item.total_quantity != null ? String(gramsToUnit(item.total_quantity, ratio)) : '')
            setInvAlertThreshold(item.daily_consumption != null ? String(gramsToUnit(item.daily_consumption, ratio)) : '')
        } else {
            setInvTotalQty(item.total_quantity != null ? String(item.total_quantity) : '')
            setInvAlertThreshold(item.daily_consumption != null ? String(item.daily_consumption) : '')
        }
        setInventoryModalOpen(true)
    }

    const openEditHealth = (item: HealthRecord) => {
        setEditingHealthId(item.id)
        if (item.type === 'medical' && (item.name.includes('呕吐') || item.name.toLowerCase().includes('vomit'))) {
            setHealthType('vomit')
        } else {
            setHealthType(item.type)
        }
        setHealthName(item.name)
        setHealthDate(item.date)
        setHealthNextDue(item.next_due || '')
        setHealthNotes(item.notes || '')
        if (item.type === 'medical') {
            const normalized = item.name.toLowerCase()
            if (item.name.includes('呕吐') || normalized.includes('vomit')) setHealthMedicalPreset('vomit')
            else if (item.name.includes('咳嗽') || normalized.includes('cough')) setHealthMedicalPreset('cough')
            else if (item.name.includes('发热') || normalized.includes('fever')) setHealthMedicalPreset('fever')
            else setHealthMedicalPreset('other')
        }
        setHealthModalOpen(true)
    }

    const deleteHealthRecord = async (id: string) => {
        try {
            await supabase.from('health_records').delete().eq('id', id)
            lightHaptic()
            pushToast('success', l('健康记录已删除', 'Health record deleted'))
            await loadData()
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('删除失败，请稍后重试', 'Delete failed, please try again later')))
        }
    }

    const deleteInventoryItem = async (id: string) => {
        try {
            await supabase.from('inventory').delete().eq('id', id)
            lightHaptic()
            pushToast('success', l('物资已删除', 'Inventory item deleted'))
            await loadData()
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('删除失败，请稍后重试', 'Delete failed, please try again later')))
        }
    }

    const handleWeightSave = async () => {
        if (!catId || !user) return
        const kg = parseFloat(weightValue)
        if (isNaN(kg) || kg < 0.1 || kg > 30) {
            setWeightError(l('体重需在 0.1 到 30kg 之间', 'Weight must be between 0.1 and 30kg'))
            return
        }
        setWeightError('')

        setWeightSaving(true)
        try {
            if (editingWeightId) {
                await supabase
                    .from('weight_records')
                    .update({
                        weight_kg: kg,
                        recorded_at: `${weightDate}T12:00:00.000Z`,
                    })
                    .eq('id', editingWeightId)
            } else {
                await supabase.from('weight_records').insert({
                    cat_id: catId,
                    weight_kg: kg,
                    recorded_at: `${weightDate}T12:00:00.000Z`,
                    created_by: user.id,
                })
            }

            setWeightModalOpen(false)
            resetWeightForm()
            await loadData()
            lightHaptic()
            pushToast('success', editingWeightId ? l('体重已更新', 'Weight updated') : l('体重记录已保存', 'Weight record saved'))
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('体重保存失败，请稍后重试', 'Failed to save weight, please try again later')))
        } finally {
            setWeightSaving(false)
        }
    }

    const deleteWeightRecord = async (id: string) => {
        try {
            await supabase.from('weight_records').delete().eq('id', id)
            lightHaptic()
            pushToast('success', l('体重记录已删除', 'Weight record deleted'))
            await loadData()
        } catch (err) {
            pushToast('error', getErrorMessage(err, l('删除失败，请稍后重试', 'Delete failed, please try again later')))
        }
    }

    const confirmDelete = async () => {
        if (!pendingDelete) return
        setDeleteSubmitting(true)
        try {
            if (pendingDelete.type === 'health') {
                await deleteHealthRecord(pendingDelete.id)
            }
            if (pendingDelete.type === 'inventory') {
                await deleteInventoryItem(pendingDelete.id)
            }
            if (pendingDelete.type === 'weight') {
                await deleteWeightRecord(pendingDelete.id)
            }
        } finally {
            setDeleteSubmitting(false)
            setPendingDelete(null)
        }
    }

    const exportVetReport = (lang: 'zh' | 'en') => {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
        const recentWeights = weights.filter((w) => new Date(w.recorded_at).getTime() >= cutoff)
        const recentHealth = healthRecords.filter((h) => new Date(h.date).getTime() >= cutoff)
        const recentVomit = healthRecords.filter((h) => {
            const inRange = new Date(h.date).getTime() >= cutoff
            const isVomit = h.type === 'medical' && (h.name.includes('呕吐') || h.name.toLowerCase().includes('vomit'))
            return inRange && isVomit
        })
        const recentAbnormalPoops = poops.filter((p) => {
            const inRange = new Date(p.created_at).getTime() >= cutoff
            return inRange && isAbnormalPoop(p.bristol_type, p.color)
        })

        const isZh = lang === 'zh'
        const t = isZh
            ? {
                reportTitle: '🐱 就医报告',
                last30Days: '最近30天',
                weightChange: '体重变化',
                vomitRecords: '呕吐记录',
                abnormalPoopRecords: '异常便便记录',
                healthRecords: '健康记录',
                noRecord: '暂无记录',
                noAbnormalRecord: '暂无异常记录',
                popupBlocked: '导出窗口被拦截，请允许弹窗后重试',
                typeLabel: { vaccine: '疫苗', deworming: '驱虫', medical: '就医' } as const,
                colorLabel: { red: '红色', black: '黑色', white: '白色' } as const,
                medicalFormat: (type: string, color: string) => `布里斯托${type}型，颜色${color}`,
                healthFormat: (name: string, type: string, notes?: string | null) => `${name}（${type}）${notes ? `：${notes}` : ''}`,
            }
            : {
                reportTitle: '🐱 Vet Report',
                last30Days: 'Last 30 Days',
                weightChange: 'Weight Trend',
                vomitRecords: 'Vomiting Records',
                abnormalPoopRecords: 'Abnormal Stool Records',
                healthRecords: 'Health Records',
                noRecord: 'No records',
                noAbnormalRecord: 'No abnormal records',
                popupBlocked: 'Popup blocked. Please allow popups and try again.',
                typeLabel: { vaccine: 'Vaccine', deworming: 'Deworming', medical: 'Medical' } as const,
                colorLabel: { red: 'red', black: 'black', white: 'white' } as const,
                medicalFormat: (type: string, color: string) => `Bristol type ${type}, color ${color}`,
                healthFormat: (name: string, type: string, notes?: string | null) => `${name} (${type})${notes ? `: ${notes}` : ''}`,
            }

        const dateLocale = isZh ? 'zh-CN' : 'en-US'

        const html = `
        <html><head><meta charset="utf-8" /><title>Vet Report</title>
        <style>body{font-family:-apple-system;padding:24px;line-height:1.6}h1{margin:0 0 4px}h2{margin:20px 0 8px}ul{padding-left:18px}</style>
        </head><body>
        <h1>${escapeHtml(t.reportTitle)}</h1><div>${escapeHtml(t.last30Days)}</div>
        <h2>${escapeHtml(t.weightChange)}</h2><ul>${recentWeights.map((w) => `<li>${escapeHtml(new Date(w.recorded_at).toLocaleDateString(dateLocale))}: ${escapeHtml(String(w.weight_kg))} kg</li>`).join('') || `<li>${escapeHtml(t.noRecord)}</li>`}</ul>
        <h2>${escapeHtml(t.vomitRecords)}</h2><ul>${recentVomit.map((v) => `<li>${escapeHtml(new Date(v.date).toLocaleDateString(dateLocale))}: ${escapeHtml(v.name)}${v.notes ? (isZh ? `（${escapeHtml(v.notes)}）` : ` (${escapeHtml(v.notes)})`) : ''}</li>`).join('') || `<li>${escapeHtml(t.noRecord)}</li>`}</ul>
        <h2>${escapeHtml(t.abnormalPoopRecords)}</h2><ul>${recentAbnormalPoops.map((p) => `<li>${escapeHtml(new Date(p.created_at).toLocaleDateString(dateLocale))}: ${escapeHtml(t.medicalFormat(String(p.bristol_type), t.colorLabel[p.color as 'red' | 'black' | 'white'] ?? p.color))}</li>`).join('') || `<li>${escapeHtml(t.noAbnormalRecord)}</li>`}</ul>
        <h2>${escapeHtml(t.healthRecords)}</h2><ul>${recentHealth.map((h) => `<li>${escapeHtml(new Date(h.date).toLocaleDateString(dateLocale))}: ${escapeHtml(t.healthFormat(h.name, t.typeLabel[h.type], h.notes))}</li>`).join('') || `<li>${escapeHtml(t.noRecord)}</li>`}</ul>
        </body></html>`

        const iframe = document.createElement('iframe')
        iframe.style.position = 'fixed'
        iframe.style.right = '0'
        iframe.style.bottom = '0'
        iframe.style.width = '0'
        iframe.style.height = '0'
        iframe.style.border = '0'
        iframe.setAttribute('aria-hidden', 'true')
        document.body.appendChild(iframe)

        const cleanup = () => {
            setTimeout(() => {
                iframe.remove()
            }, 1500)
        }

        try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document
            if (!doc || !iframe.contentWindow) throw new Error('print-frame-unavailable')
            doc.open()
            doc.write(html)
            doc.close()
            const runPrint = () => {
                iframe.contentWindow?.focus()
                iframe.contentWindow?.print()
                cleanup()
            }
            if (doc.readyState === 'complete') {
                runPrint()
            } else {
                iframe.onload = runPrint
            }
        } catch {
            cleanup()
            const reportWindow = window.open('', '_blank')
            if (!reportWindow) {
                pushToast('error', t.popupBlocked)
                return
            }
            reportWindow.document.write(html)
            reportWindow.document.close()
            reportWindow.focus()
            reportWindow.print()
        }
    }

    // ─── Health type labels ───────────────────────
    const healthTypeLabels = useMemo<Record<HealthFormType, { icon: string; label: string }>>(() => ({
        vaccine: { icon: HEALTH_TYPE_ICONS.vaccine, label: l('疫苗', 'Vaccine') },
        deworming: { icon: HEALTH_TYPE_ICONS.deworming, label: l('驱虫', 'Deworming') },
        medical: { icon: HEALTH_TYPE_ICONS.medical, label: l('就医', 'Medical') },
        vomit: { icon: HEALTH_TYPE_ICONS.vomit, label: l('呕吐', 'Vomit') },
    }), [l])

    // ─── Grouped health records by category ───────────────────────
    const groupedHealth = useMemo(() => {
        const groups: Record<HealthFormType, HealthRecord[]> = { vaccine: [], deworming: [], medical: [], vomit: [] }
        for (const r of healthRecords) {
            const viewType: HealthFormType = (r.type === 'medical' && (r.name.includes('呕吐') || r.name.toLowerCase().includes('vomit'))) ? 'vomit' : r.type
            groups[viewType].push(r)
        }
        return groups
    }, [healthRecords])

    const toggleCategory = (cat: HealthFormType) => {
        setCollapsedCategories(prev => {
            const next = new Set(prev)
            if (next.has(cat)) next.delete(cat)
            else next.add(cat)
            return next
        })
    }

    if (loading || catLoading) {
        return (
            <div className="stats-page fade-in">
                <div className="page-header p-4">
                    <Skeleton width="50%" height="28px" />
                    <Skeleton width="70%" height="16px" style={{ marginTop: 'var(--space-2)' }} />
                </div>
                <div className="px-4 mb-4">
                    <Card variant="default" padding="md">
                        <Skeleton width="40%" height="20px" />
                        <Skeleton height="220px" borderRadius="var(--radius-md)" style={{ marginTop: 'var(--space-3)' }} />
                    </Card>
                </div>
                <div className="px-4 mb-4">
                    <Card variant="default" padding="md">
                        <Skeleton width="40%" height="20px" />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                            <Skeleton height="52px" borderRadius="var(--radius-md)" />
                            <Skeleton height="52px" borderRadius="var(--radius-md)" />
                            <Skeleton height="52px" borderRadius="var(--radius-md)" />
                        </div>
                    </Card>
                </div>
                <div className="px-4 mb-4">
                    <Card variant="default" padding="md">
                        <Skeleton width="40%" height="20px" />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                            <Skeleton height="44px" borderRadius="var(--radius-md)" />
                            <Skeleton height="44px" borderRadius="var(--radius-md)" />
                        </div>
                    </Card>
                </div>
            </div>
        )
    }

    return (
        <div className="stats-page fade-in">
            <div className="page-header p-4">
                <h1 className="text-2xl font-bold">{text.title}</h1>
                <p className="text-secondary text-sm">{text.subtitle}</p>
            </div>

            {/* ── Snoozed Alerts Dropdown ── */}
            <div className="px-4">
                <SnoozedAlertsDropdown catId={catId} online={online} onUnsnoozeSuccess={loadData} />
            </div>

            {/* ── Unified Chart ── */}
            <div className="px-4 mb-4">
                <Card variant="default" padding="md">
                    <div className="section-row">
                        <select
                            className="form-input chart-type-select"
                            value={chartType}
                            onChange={(e) => setChartType(e.target.value as ChartType)}
                        >
                            {chartTypeOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                        <div style={{ display: 'flex', gap: '4px' }}>
                            {!isDefaultChart && (
                                <Button variant="ghost" size="sm" onClick={handleSetDefaultChart}>
                                    {text.setDefault}
                                </Button>
                            )}
                            {chartType === 'weight' && (
                                <Button variant="ghost" size="sm" onClick={() => { resetWeightForm(); setWeightModalOpen(true) }}>
                                    {text.add}
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Shared date range picker for all charts */}
                    <div className="chart-date-range-row">
                        <input type="date" className="form-input" value={chartStartDate} onChange={(e) => setChartStartDate(e.target.value)} aria-label={text.dateFrom} />
                        <span className="text-secondary text-sm">~</span>
                        <input type="date" className="form-input" value={chartEndDate} min={chartStartDate} onChange={(e) => setChartEndDate(e.target.value)} aria-label={text.dateTo} />
                    </div>

                    {/* Weight Trend */}
                    {chartType === 'weight' && (
                        <>
                            {chartData.length >= 2 ? (
                                <div className="chart-container">
                                    <ResponsiveContainer width="100%" height={220}>
                                        <LineChart data={chartData}>
                                            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                                            <XAxis dataKey="date" tick={CHART_TICK_STYLE} stroke={CHART_AXIS_STROKE} />
                                            <YAxis domain={['dataMin - 0.3', 'dataMax + 0.3']} tick={CHART_TICK_STYLE} stroke={CHART_AXIS_STROKE} unit=" kg" />
                                            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                                            <Line type="monotone" dataKey="weight" stroke="var(--color-primary)" strokeWidth={2.5} dot={WEIGHT_DOT} activeDot={WEIGHT_ACTIVE_DOT} name={text.weightName} unit=" kg" />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            ) : (
                                <div className="empty-state-sm">
                                    <div className="empty-illu-wrap"><EmptyCatIllustration mood="play" /></div>
                                    <p className="text-secondary text-sm">{chartData.length === 1 ? text.currentWeight(chartData[0].weight) : text.noWeight}</p>
                                </div>
                            )}
                        </>
                    )}

                    {/* Poop Distribution */}
                    {chartType === 'poop' && (
                        <div className="chart-container">
                            {bristolDistributionData.length > 0 ? (
                                <ResponsiveContainer width="100%" height={220}>
                                    <PieChart>
                                        <Pie data={bristolDistributionData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={42} outerRadius={72} paddingAngle={2}>
                                            {bristolDistributionData.map((entry, index) => (
                                                <Cell key={`${entry.name}-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                                        <Legend wrapperStyle={LEGEND_STYLE} />
                                    </PieChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="empty-state-sm">
                                    <p className="text-secondary text-sm">{text.noPoop}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Missing-you Count */}
                    {chartType === 'miss' && (
                        <div className="chart-container">
                            <ResponsiveContainer width="100%" height={180}>
                                <LineChart data={missTrendData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                                    <XAxis dataKey="date" tick={CHART_TICK_STYLE_SM} interval={Math.max(1, Math.floor(chartDaysSpan / 10))} />
                                    <YAxis allowDecimals={false} tick={CHART_TICK_STYLE_SM} />
                                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                                    <Line type="monotone" dataKey="count" stroke="var(--color-accent)" strokeWidth={2.5} dot={MISS_DOT} activeDot={MISS_ACTIVE_DOT} name={text.missCountName} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    )}

                    {/* Feed Count */}
                    {chartType === 'feed' && (
                        <div className="chart-container">
                            <ResponsiveContainer width="100%" height={180}>
                                <LineChart data={feedTrendData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                                    <XAxis dataKey="date" tick={CHART_TICK_STYLE_SM} interval={Math.max(1, Math.floor(chartDaysSpan / 10))} />
                                    <YAxis allowDecimals={false} tick={CHART_TICK_STYLE_SM} />
                                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                                    <Line type="monotone" dataKey="count" stroke="var(--color-secondary)" strokeWidth={2.5} dot={FEED_DOT} activeDot={FEED_ACTIVE_DOT} name={text.feedCountName} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    )}

                    {/* Per-Inventory Feed Count / Grams */}
                    {chartType === 'inventoryFeed' && (
                        <div className="chart-container">
                            <div className="flex gap-2 mb-3" style={{ justifyContent: 'center' }}>
                                <Button
                                    variant={feedStatMode === 'grams' ? 'primary' : 'ghost'}
                                    size="sm"
                                    onClick={() => setFeedStatMode('grams')}
                                >
                                    {l('按消耗量 (g)', 'By Grams (g)')}
                                </Button>
                                <Button
                                    variant={feedStatMode === 'count' ? 'primary' : 'ghost'}
                                    size="sm"
                                    onClick={() => setFeedStatMode('count')}
                                >
                                    {l('按喂食次数 (次)', 'By Times')}
                                </Button>
                            </div>
                            {inventoryFeedData.length > 0 ? (
                                <ResponsiveContainer width="100%" height={220}>
                                    <PieChart>
                                        <Pie data={inventoryFeedData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={42} outerRadius={72} paddingAngle={2}>
                                            {inventoryFeedData.map((entry, index) => (
                                                <Cell key={`${entry.name}-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={CHART_TOOLTIP_STYLE}
                                            formatter={(val: unknown) => [
                                                feedStatMode === 'grams' ? `${val} g` : `${val} ${l('次', 'times')}`,
                                                feedStatMode === 'grams' ? l('消耗量', 'Consumption') : l('喂食次数', 'Feeding count'),
                                            ]}
                                        />
                                        <Legend wrapperStyle={LEGEND_STYLE} />
                                    </PieChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="empty-state-sm">
                                    <p className="text-secondary text-sm">{l('暂无喂食记录', 'No feeding records yet')}</p>
                                </div>
                            )}
                        </div>
                    )}
                </Card>
            </div>

            {/* ── Health Records ── */}
            <div className="px-4 mb-4">
                <Card variant="default" padding="md">
                    <div className="section-row">
                        <h2 className="text-lg font-semibold">{l('💉 健康记录', '💉 Health Records')}</h2>
                        <Button variant="ghost" size="sm" onClick={() => { resetHealthForm(); setHealthModalOpen(true) }}>
                            {l('+ 添加', '+ Add')}
                        </Button>
                    </div>

                    {healthRecords.length > 0 ? (
                        <div className="health-list">
                            {CATEGORY_ORDER.map((cat) => {
                                const records = groupedHealth[cat]
                                if (records.length === 0) return null
                                const config = healthTypeLabels[cat]
                                const isCollapsed = collapsedCategories.has(cat)
                                return (
                                    <div key={cat} className="health-category">
                                        <button
                                            type="button"
                                            className="health-category-header"
                                            onClick={() => toggleCategory(cat)}
                                        >
                                            <span className="health-category-icon">{config.icon}</span>
                                            <span className="health-category-label">{config.label}</span>
                                            <span className="health-category-count">{records.length}</span>
                                            <span className={`health-category-chevron ${isCollapsed ? '' : 'health-category-chevron-open'}`}>▸</span>
                                        </button>
                                        {!isCollapsed && (
                                            <div className="health-category-items">
                                                {records.map((r) => {
                                                    const viewType: HealthFormType = (r.type === 'medical' && (r.name.includes('呕吐') || r.name.toLowerCase().includes('vomit'))) ? 'vomit' : r.type
                                                    const itemConfig = healthTypeLabels[viewType]
                                                    const isPastDue = r.next_due && new Date(r.next_due) < new Date()
                                                    return (
                                                        <SwipeableRow key={r.id} onDelete={() => setPendingDelete({ id: r.id, type: 'health' })}>
                                                            <button type="button" className={`health-item health-item-vertical ${isPastDue ? 'health-past-due' : ''}`} onClick={() => openEditHealth(r)}>
                                                                <div className="health-item-top">
                                                                    <span className="health-icon">{itemConfig.icon}</span>
                                                                    <div className="health-info">
                                                                        <span className="text-sm font-semibold">{r.name}</span>
                                                                        <span className="text-muted text-xs">{itemConfig.label} · {format(new Date(r.date), 'yyyy/MM/dd')}</span>
                                                                        {r.next_due && (
                                                                            <span className={`text-xs ${isPastDue ? 'text-danger' : 'text-secondary'}`}>
                                                                                {l('下次：', 'Next: ')}{format(new Date(r.next_due), 'yyyy/MM/dd')} {isPastDue ? l('⚠️ 已过期', '⚠️ Overdue') : ''}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                {isPastDue && (r.type === 'vaccine' || r.type === 'deworming') && (
                                                                    <div className="health-notify-actions health-notify-actions-vertical">
                                                                        <button
                                                                            type="button"
                                                                            className="health-renew-btn"
                                                                            onClick={(e) => { e.stopPropagation(); renew.openRenewModal(r) }}
                                                                        >
                                                                            {l('🔄 续期', '🔄 Renew')}
                                                                        </button>
                                                                        <button
                                                                            type="button"
                                                                            className="health-notify-stop-btn"
                                                                            disabled={renew.stopSaving === r.id || !online}
                                                                            onClick={(e) => { e.stopPropagation(); setPendingStopRecord(r) }}
                                                                        >
                                                                            {renew.stopSaving === r.id ? l('停止中...', 'Stopping...') : l('停止', 'Stop')}
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </button>
                                                        </SwipeableRow>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <div className="empty-state-sm">
                            <p className="text-secondary text-sm">{l('暂无健康记录', 'No health records yet')}</p>
                        </div>
                    )}
                </Card>
            </div>

            {/* ── Inventory ── */}
            <div className="px-4 mb-4">
                <Card variant="default" padding="md">
                    <div className="section-row">
                        <h2 className="text-lg font-semibold">{l('📦 物资库存', '📦 Inventory')}</h2>
                        <Button variant="ghost" size="sm" onClick={() => { resetInvForm(); setInventoryModalOpen(true) }}>
                            {l('+ 添加', '+ Add')}
                        </Button>
                    </div>

                    {inventory.length > 0 ? (
                        <div className="inventory-list">
                            {inventory.map((item) => {
                                const derivedStatus = computeInventoryStatus(item)
                                return (
                                    <SwipeableRow key={item.id} onDelete={() => setPendingDelete({ id: item.id, type: 'inventory' })}>
                                        <button
                                            type="button"
                                            className="inventory-item"
                                            onClick={() => openEditInventory(item)}
                                        >
                                            <div className="inventory-item-info">
                                                <span className="text-sm">{item.icon ? `${item.icon} ` : ''}{item.item_name}</span>
                                                {item.total_quantity != null && (
                                                    <span className="text-xs text-muted">
                                                        {l(`库存：${formatInventoryDisplay(item.total_quantity, item.unit, item.unit_ratio ?? 1)}`, `Stock: ${formatInventoryDisplay(item.total_quantity, item.unit, item.unit_ratio ?? 1)}`)}
                                                    </span>
                                                )}
                                            </div>
                                            <StatusBadge status={derivedStatus} size="sm" />
                                        </button>
                                    </SwipeableRow>
                                )
                            })}
                        </div>
                    ) : (
                        <div className="empty-state-sm">
                            <div className="empty-illu-wrap"><EmptyCatIllustration mood="hungry" /></div>
                            <p className="text-secondary text-sm">{l('添加猫粮、猫砂等物资，管理库存状态', 'Add cat food, litter and other items to manage stock status')}</p>
                        </div>
                    )}
                </Card>
            </div>

            {/* ── Expiry Reminders ── */}
            <div className="px-4 mb-4">
                <Card variant="default" padding="md">
                    <div className="section-row">
                        <h2 className="text-lg font-semibold">{l('🗑️ 物品过期提醒', '🗑️ Item Expiry Reminders')}</h2>
                        <Button variant="ghost" size="sm" onClick={() => { resetExpiryForm(); setExpiryModalOpen(true) }}>
                            {l('+ 添加', '+ Add')}
                        </Button>
                    </div>

                    {inventoryExpiryReminders.length > 0 ? (
                        <div className="expiry-reminder-list">
                            {inventoryExpiryReminders.map((item) => {
                                const hoursLeft = computeInventoryExpiryHoursLeft(item)
                                const isOverdue = new Date(item.expires_at).getTime() <= Date.now()
                                const statusText = isOverdue
                                    ? l(`已过期 ${Math.max(1, Math.abs(hoursLeft))} 小时`, `Expired ${Math.max(1, Math.abs(hoursLeft))}h ago`)
                                    : hoursLeft === 0
                                        ? l('即将过期', 'Expiring soon')
                                        : l(`${hoursLeft} 小时后过期`, `Expires in ${hoursLeft}h`)

                                return (
                                    <div
                                        key={item.id}
                                        className={`expiry-reminder-item ${isOverdue ? 'expiry-reminder-overdue' : ''}`}
                                    >
                                        <div className="expiry-reminder-info">
                                            <span className="text-sm font-semibold">{item.item_name}</span>
                                            <span className={`text-xs ${isOverdue ? 'text-danger' : 'text-secondary'}`}>{statusText}</span>
                                        </div>
                                        {isOverdue ? (
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => { void markExpiryReminderDiscarded(item.id) }}
                                                disabled={!online || discardingExpiryId === item.id}
                                            >
                                                {discardingExpiryId === item.id ? l('处理中...', 'Processing...') : l('已丢弃', 'Discarded')}
                                            </Button>
                                        ) : (
                                            <span className="text-xs text-muted">{l('待过期', 'Pending expiry')}</span>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <div className="empty-state-sm">
                            <p className="text-secondary text-sm">{l('添加湿粮、罐头等物品，到期后会显示提醒并可标记已丢弃', 'Add wet food or cans to get expiry alerts and mark them discarded')}</p>
                        </div>
                    )}
                </Card>
            </div>

            {/* ── Health Modal ── */}
            <Modal isOpen={healthModalOpen} onClose={() => { setHealthModalOpen(false); resetHealthForm() }} title={editingHealthId ? l('💉 编辑健康记录', '💉 Edit Health Record') : l('💉 添加健康记录', '💉 Add Health Record')}>
                <div className="health-form">
                    <div className="form-group">
                        <label className="form-label">{l('类型', 'Type')}</label>
                        <div className="health-type-grid">
                            {(['vaccine', 'deworming', 'medical', 'vomit'] as const).map((t) => (
                                <button
                                    key={t}
                                    className={`health-type-btn ${healthType === t ? 'health-type-active' : ''}`}
                                    onClick={() => {
                                        setHealthType(t)
                                        if (t === 'medical') {
                                            const map = {
                                                vomit: l('呕吐', 'Vomit'),
                                                cough: l('咳嗽', 'Cough'),
                                                fever: l('发热', 'Fever'),
                                                other: '',
                                            }
                                            setHealthName(map[healthMedicalPreset])
                                            setHealthNextDue('')
                                        }
                                        if (t === 'vomit') {
                                            setHealthName(l('呕吐', 'Vomit'))
                                            setHealthNextDue('')
                                        }
                                    }}
                                >
                                    {healthTypeLabels[t].icon} {healthTypeLabels[t].label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {healthType === 'medical' ? (
                        <>
                            <div className="form-group">
                                <label className="form-label" htmlFor="health-medical-preset">{l('就医类型', 'Medical type')}</label>
                                <select
                                    id="health-medical-preset"
                                    className="form-input"
                                    value={healthMedicalPreset}
                                    onChange={(e) => {
                                        const next = e.target.value as 'vomit' | 'cough' | 'fever' | 'other'
                                        setHealthMedicalPreset(next)
                                        if (next === 'vomit') setHealthName(l('呕吐', 'Vomit'))
                                        if (next === 'cough') setHealthName(l('咳嗽', 'Cough'))
                                        if (next === 'fever') setHealthName(l('发热', 'Fever'))
                                        if (next === 'other') setHealthName('')
                                    }}
                                >
                                    <option value="vomit">{l('呕吐', 'Vomit')}</option>
                                    <option value="cough">{l('咳嗽', 'Cough')}</option>
                                    <option value="fever">{l('发热', 'Fever')}</option>
                                    <option value="other">{l('其他', 'Other')}</option>
                                </select>
                            </div>
                            {healthMedicalPreset === 'other' && (
                                <div className="form-group">
                                    <label className="form-label" htmlFor="health-name">{l('症状名称', 'Symptom name')}</label>
                                    <input
                                        id="health-name"
                                        className="form-input"
                                        placeholder={l('请输入症状', 'Enter symptom')}
                                        value={healthName}
                                        onChange={(e) => setHealthName(e.target.value)}
                                    />
                                </div>
                            )}
                            <div className="form-group">
                                <label className="form-label" htmlFor="health-notes">{l('症状备注', 'Symptom notes')}</label>
                                <textarea
                                    id="health-notes"
                                    className="form-input"
                                    placeholder={l('可填写频次、状态、触发情况', 'Optional frequency, status and trigger notes')}
                                    rows={3}
                                    value={healthNotes}
                                    onChange={(e) => setHealthNotes(e.target.value)}
                                />
                            </div>
                        </>
                    ) : healthType === 'vomit' ? (
                        <div className="form-group">
                            <label className="form-label" htmlFor="health-notes">{l('呕吐备注', 'Vomit notes')}</label>
                            <textarea
                                id="health-notes"
                                className="form-input"
                                placeholder={l('可填写频次、状态、触发情况', 'Optional frequency, status and trigger notes')}
                                rows={3}
                                value={healthNotes}
                                onChange={(e) => setHealthNotes(e.target.value)}
                            />
                        </div>
                    ) : (
                        <div className="form-group">
                            <label className="form-label" htmlFor="health-name">{l('名称', 'Name')}</label>
                            <input
                                id="health-name"
                                className="form-input"
                                placeholder={healthType === 'vaccine' ? l('如：三联疫苗', 'e.g. FVRCP vaccine') : l('如：大宠爱', 'e.g. Broadline')}
                                value={healthName}
                                onChange={(e) => setHealthName(e.target.value)}
                            />
                        </div>
                    )}

                    <div className="form-row">
                        <div className="form-group flex-1">
                            <label className="form-label" htmlFor="health-date">{l('日期', 'Date')}</label>
                            <input
                                id="health-date"
                                type="date"
                                className="form-input"
                                value={healthDate}
                                max={format(new Date(), 'yyyy-MM-dd')}
                                onChange={(e) => setHealthDate(e.target.value)}
                            />
                        </div>
                        {healthType === 'vaccine' || healthType === 'deworming' ? (
                            <div className="form-group flex-1">
                                <label className="form-label" htmlFor="health-next">{l('下次到期', 'Next due')}</label>
                                <input
                                    id="health-next"
                                    type="date"
                                    className="form-input"
                                    value={healthNextDue}
                                    min={healthDate || undefined}
                                    onChange={(e) => setHealthNextDue(e.target.value)}
                                />
                            </div>
                        ) : null}
                    </div>

                    <Button variant="primary" fullWidth onClick={handleHealthSave} disabled={healthSaving || !online}>
                        {healthSaving ? l('保存中...', 'Saving...') : editingHealthId ? l('更新记录', 'Update record') : l('保存记录', 'Save record')}
                    </Button>
                </div>
            </Modal>

            {/* ── Inventory Modal ── */}
            <Modal isOpen={inventoryModalOpen} onClose={() => { setInventoryModalOpen(false); resetInvForm() }} title={editingInvId ? l('📦 编辑库存', '📦 Edit Inventory') : l('📦 添加物资', '📦 Add Inventory')}>
                <div className="inv-form">
                    <div className="form-group">
                        <label className="form-label" htmlFor="inv-name">{l('物资名称', 'Item name')}</label>
                        <input
                            id="inv-name"
                            className="form-input"
                            placeholder={l('如：猫粮、猫砂、罐头', 'e.g. Cat food, litter, canned food')}
                            value={invItemName}
                            onChange={(e) => setInvItemName(e.target.value)}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label">{l('图标', 'Icon')}</label>
                        <div className="inv-icon-grid">
                            {INVENTORY_ICONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    className={`inv-icon-btn ${invIcon === opt.value ? 'inv-icon-active' : ''}`}
                                    onClick={() => setInvIcon(invIcon === opt.value ? null : opt.value)}
                                    title={opt.label}
                                >
                                    {opt.value}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="form-group">
                        <label className="form-label">{l('计量单位', 'Unit')}</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                            {[
                                { label: l('克 (g)', 'Grams (g)'), unit: 'g', ratio: 1 },
                                { label: l('罐 (can)', 'Can'), unit: '罐', ratio: 85 },
                                { label: l('袋 (bag)', 'Bag'), unit: '袋', ratio: 2000 },
                                { label: l('支 (stick)', 'Stick'), unit: '支', ratio: 15 },
                                { label: l('包 (pack)', 'Pack'), unit: '包', ratio: 500 },
                            ].map((preset) => (
                                <button
                                    key={preset.unit}
                                    type="button"
                                    className={`tag-btn ${!isCustomInvUnit && invUnit === preset.unit ? 'tag-btn-active' : ''}`}
                                    onClick={() => {
                                        setIsCustomInvUnit(false)
                                        setInvUnit(preset.unit)
                                        setInvUnitRatio(String(preset.ratio))
                                    }}
                                >
                                    {preset.label}
                                </button>
                            ))}
                            <button
                                type="button"
                                className={`tag-btn ${isCustomInvUnit ? 'tag-btn-active' : ''}`}
                                onClick={() => {
                                    setIsCustomInvUnit(true)
                                    if (['g', '罐', '袋', '支', '包'].includes(invUnit)) {
                                        setInvUnit('')
                                        setInvUnitRatio('1')
                                    }
                                }}
                            >
                                {l('其他 (自定义)', 'Other (Custom)')}
                            </button>
                        </div>
                    </div>

                    {isCustomInvUnit && (
                        <div className="form-group">
                            <label className="form-label" htmlFor="inv-custom-unit">
                                {l('自定义单位名称', 'Custom unit name')}
                            </label>
                            <input
                                id="inv-custom-unit"
                                type="text"
                                className="form-input"
                                placeholder={l('如：盒、条、颗、瓶、箱', 'e.g. box, bottle, bar, can')}
                                value={invUnit}
                                onChange={(e) => setInvUnit(e.target.value)}
                                maxLength={10}
                            />
                        </div>
                    )}

                    {invUnit !== 'g' && (
                        <div className="form-group">
                            <label className="form-label" htmlFor="inv-unit-ratio">
                                {l(`每 1 ${invUnit.trim() || l('单位', 'unit')} 等于多少克 (g)`, `Grams (g) per 1 ${invUnit.trim() || l('unit', 'unit')}`)}
                            </label>
                            <input
                                id="inv-unit-ratio"
                                type="number"
                                min="0.1"
                                step="0.1"
                                className="form-input"
                                placeholder="0"
                                value={invUnitRatio}
                                onChange={(e) => setInvUnitRatio(e.target.value)}
                            />
                        </div>
                    )}

                    <div className="form-row">
                        <div className="form-group flex-1">
                            <label className="form-label" htmlFor="inv-total-qty">
                                {l('总量', 'Total quantity')} ({invUnit === 'g' ? 'g' : (invUnit.trim() || l('单位', 'unit'))})
                            </label>
                            <input
                                id="inv-total-qty"
                                type="number"
                                min="0"
                                step={invUnit === 'g' ? '1' : '0.1'}
                                className="form-input"
                                placeholder="0"
                                value={invTotalQty}
                                onChange={(e) => setInvTotalQty(e.target.value)}
                            />
                        </div>
                        <div className="form-group flex-1">
                            <label className="form-label" htmlFor="inv-alert-threshold">
                                {l('提醒线', 'Alert threshold')} ({invUnit === 'g' ? 'g' : (invUnit.trim() || l('单位', 'unit'))})
                            </label>
                            <input
                                id="inv-alert-threshold"
                                type="number"
                                min="0"
                                step={invUnit === 'g' ? '1' : '0.1'}
                                className="form-input"
                                placeholder="0"
                                value={invAlertThreshold}
                                onChange={(e) => setInvAlertThreshold(e.target.value)}
                            />
                        </div>
                    </div>

                    {invTotalQty && parseFloat(invTotalQty) > 0 && invUnit !== 'g' && parseFloat(invUnitRatio) > 0 && (
                        <div style={{ fontSize: '0.82rem', color: 'var(--color-primary)', marginTop: '-8px', marginBottom: '8px' }}>
                            ℹ️ {l(`折合实际总库存：${unitToGrams(parseFloat(invTotalQty), parseFloat(invUnitRatio))} 克 (g)`, `Equivalent total stock: ${unitToGrams(parseFloat(invTotalQty), parseFloat(invUnitRatio))} g`)}
                        </div>
                    )}

                    {invTotalQty && invAlertThreshold && parseFloat(invAlertThreshold) > 0 && (
                        <div className="inv-preview" style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', background: 'var(--glass-bg)' }}>
                            <p className="text-sm text-secondary">
                                {(() => {
                                    const qty = parseFloat(invTotalQty)
                                    const threshold = parseFloat(invAlertThreshold)
                                    if (qty <= threshold) return <span style={{ color: 'var(--color-danger)' }}>{l('🔴 已达提醒线', '🔴 Below threshold')}</span>
                                    if (qty <= threshold * 1.5) return <span style={{ color: 'var(--color-warning)' }}>{l('🟡 接近提醒线', '🟡 Near threshold')}</span>
                                    return <span style={{ color: 'var(--color-success)' }}>{l('🟢 充足', '🟢 Sufficient')}</span>
                                })()}
                            </p>
                        </div>
                    )}

                    <Button variant="primary" fullWidth onClick={handleInventorySave} disabled={invSaving || !online}>
                        {invSaving ? l('保存中...', 'Saving...') : editingInvId ? l('更新库存', 'Update inventory') : l('添加物资', 'Add inventory')}
                    </Button>
                </div>
            </Modal>

            <Modal isOpen={expiryModalOpen} onClose={() => { setExpiryModalOpen(false); resetExpiryForm() }} title={l('🗑️ 添加过期提醒', '🗑️ Add Expiry Reminder')}>
                <div className="inv-form">
                    <div className="form-group">
                        <label className="form-label" htmlFor="expiry-item-name">{l('物品名称', 'Item name')}</label>
                        <input
                            id="expiry-item-name"
                            className="form-input"
                            placeholder={l('如：湿粮、罐头、猫条', 'e.g. Wet food, canned food, treats')}
                            value={expiryItemName}
                            onChange={(e) => setExpiryItemName(e.target.value)}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="expiry-in-hours">{l('多久后过期（小时）', 'Expires in (hours)')}</label>
                        <input
                            id="expiry-in-hours"
                            type="number"
                            min="1"
                            step="1"
                            className="form-input"
                            placeholder="0"
                            value={expiryInHours}
                            onChange={(e) => setExpiryInHours(e.target.value)}
                        />
                        <p className="text-xs text-muted" style={{ marginTop: '6px' }}>
                            {expiryPreviewDateTime ? l(`预计过期时间：${expiryPreviewDateTime}`, `Estimated expiry time: ${expiryPreviewDateTime}`) : l('请输入有效小时数', 'Please enter valid hours')}
                        </p>
                    </div>

                    <Button
                        variant="primary"
                        fullWidth
                        onClick={handleExpiryReminderSave}
                        disabled={expirySaving || !online || !expiryItemName.trim() || !expiryInHours || Number(expiryInHours) <= 0}
                    >
                        {expirySaving ? l('保存中...', 'Saving...') : l('保存提醒', 'Save reminder')}
                    </Button>
                </div>
            </Modal>

            <Modal isOpen={weightModalOpen} onClose={() => { setWeightModalOpen(false); resetWeightForm() }} title={editingWeightId ? l('⚖️ 编辑体重', '⚖️ Edit Weight') : l('⚖️ 添加体重', '⚖️ Add Weight')}>
                <div className="weight-form">
                    <div className="form-row">
                        <div className="form-group flex-1">
                            <label className="form-label" htmlFor="weight-value">{l('体重 (kg)', 'Weight (kg)')}</label>
                            <input
                                id="weight-value"
                                type="number"
                                min="0.1"
                                max="30"
                                step="0.01"
                                className="form-input"
                                placeholder="0"
                                value={weightValue}
                                onChange={(e) => {
                                    setWeightValue(e.target.value)
                                    setWeightError('')
                                }}
                                aria-invalid={weightError ? true : undefined}
                                aria-describedby={weightError ? 'stats-weight-error' : undefined}
                            />
                        </div>
                        <div className="form-group flex-1">
                            <label className="form-label" htmlFor="weight-date">{l('日期', 'Date')}</label>
                            <input
                                id="weight-date"
                                type="date"
                                className="form-input"
                                value={weightDate}
                                max={format(new Date(), 'yyyy-MM-dd')}
                                onChange={(e) => setWeightDate(e.target.value)}
                            />
                        </div>
                    </div>
                    {weightError && <p className="text-xs text-danger" id="stats-weight-error">{weightError}</p>}
                    <Button variant="primary" fullWidth onClick={handleWeightSave} disabled={weightSaving || !online}>
                        {weightSaving ? l('保存中...', 'Saving...') : editingWeightId ? l('更新体重', 'Update weight') : l('保存体重', 'Save weight')}
                    </Button>
                </div>
            </Modal>

            <Modal isOpen={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)} title={l('确认删除？', 'Confirm delete?')}>
                <div className="weight-form">
                    <p className="text-sm text-secondary">{l('此操作不可恢复，确认继续删除吗？', 'This action cannot be undone. Continue deleting?')}</p>
                    <Button variant="primary" fullWidth onClick={confirmDelete} disabled={deleteSubmitting}>
                        {deleteSubmitting ? l('删除中...', 'Deleting...') : l('确认删除', 'Confirm delete')}
                    </Button>
                </div>
            </Modal>

            <Modal isOpen={exportModalOpen} onClose={() => !exporting && setExportModalOpen(false)} title={l('导出全部记录', 'Export Records')}>
                <div className="weight-form">
                    <div className="form-group">
                        <label className="form-label" htmlFor="export-days">{l(`时间跨度：最近 ${exportDays} 天（1 - ${maxExportDays}）`, `Range: last ${exportDays} days (1 - ${maxExportDays})`)}</label>
                        <input
                            id="export-days"
                            type="range"
                            min="1"
                            max={String(maxExportDays)}
                            value={exportDays}
                            onChange={(event) => setExportDays(Number(event.target.value))}
                            disabled={exporting}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label">{l('导出类型（可多选）', 'Export types (multi-select)')}</label>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            {(Object.keys(exportTypes) as ExportTypeKey[]).map((key) => {
                                const labels: Record<ExportTypeKey, string> = {
                                    weight: l('体重', 'Weight'),
                                    poop: l('便便', 'Poop'),
                                    miss: l('咪被想', 'Missing-you'),
                                    health: l('健康', 'Health'),
                                    inventory: l('库存', 'Inventory'),
                                    diary: l('日记', 'Diary'),
                                    mood: l('心情', 'Mood'),
                                    feed: l('喂食', 'Feeding'),
                                }

                                return (
                                    <label key={key} className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <input
                                            type="checkbox"
                                            checked={exportTypes[key]}
                                            onChange={() => handleToggleExportType(key)}
                                            disabled={exporting}
                                        />
                                        <span>{labels[key]}</span>
                                    </label>
                                )
                            })}
                        </div>
                    </div>

                    <Button variant="primary" fullWidth onClick={exportSelectedRecords} disabled={exporting || !catId}>
                        {exporting ? l('导出中...', 'Exporting...') : l('开始导出', 'Start export')}
                    </Button>
                </div>
            </Modal>

            {/* ── Renew Modal ── */}
            <RenewModal
                isOpen={renew.renewModalOpen}
                onClose={renew.closeRenewModal}
                record={renew.renewRecord}
                renewDate={renew.renewDate}
                onRenewDateChange={renew.setRenewDate}
                renewNextDue={renew.renewNextDue}
                onRenewNextDueChange={renew.setRenewNextDue}
                renewNotes={renew.renewNotes}
                onRenewNotesChange={renew.setRenewNotes}
                saving={renew.renewSaving}
                onSave={renew.handleRenewSave}
                online={online}
                idSuffix="-stats"
            />

            {/* ── Stop Confirmation Modal ── */}
            <Modal
                isOpen={pendingStopRecord !== null}
                onClose={() => setPendingStopRecord(null)}
                title={l('停止提醒', 'Stop Reminder')}
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                    <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                        {pendingStopRecord && l(`确定停止「${pendingStopRecord.name}」的到期提醒吗？此操作不可撤销。`, `Stop the reminder for "${pendingStopRecord.name}"? This cannot be undone.`)}
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                        <button
                            type="button"
                            className="health-notify-stop-btn"
                            style={{ width: '100%', padding: '10px', fontSize: '14px', color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
                            disabled={!online || (pendingStopRecord ? renew.stopSaving === pendingStopRecord.id : false)}
                            onClick={() => {
                                if (!pendingStopRecord) return
                                const r = pendingStopRecord
                                setPendingStopRecord(null)
                                renew.handleStop(r)
                            }}
                        >
                            {l('确认停止', 'Confirm')}
                        </button>
                        <button
                            type="button"
                            className="health-notify-update-btn"
                            style={{ width: '100%', padding: '10px', fontSize: '14px' }}
                            onClick={() => setPendingStopRecord(null)}
                        >
                            {l('取消', 'Cancel')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* ── Vet Report Language Selection Modal ── */}
            <Modal
                isOpen={vetReportLangModalOpen}
                onClose={() => setVetReportLangModalOpen(false)}
                title={l('选择报告语言', 'Select Report Language')}
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    <Button variant="primary" fullWidth onClick={() => { setVetReportLangModalOpen(false); exportVetReport('zh') }}>
                        中文
                    </Button>
                    <Button variant="secondary" fullWidth onClick={() => { setVetReportLangModalOpen(false); exportVetReport('en') }}>
                        English
                    </Button>
                </div>
            </Modal>
        </div>
    )
}
