import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useRealtimeSubscription } from '../lib/realtime'
import { useToastStore } from '../stores/useToastStore'
import { getErrorMessage } from '../lib/errorMessage'
import { withTimeout } from '../lib/promiseTimeout'
import { isAbnormalPoop } from '../lib/constants'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, differenceInDays } from 'date-fns'
import { useI18n } from '../lib/i18n'
import type { MoodType, DiaryEntry, InventoryItem, FeedStatus, HealthRecord, InventoryExpiryReminder } from '../types/database.types'
import { computeInventoryStatus, computeInventoryExpiryHoursLeft, isItemActivelySnoozed, computeSnoozeDisplay } from '../types/database.types'

export interface DashboardData {
    todayFeeds: FeedStatus[]
    todayMood: MoodType | null
    monthMoodMap: Record<string, MoodType>
    latestDiary: DiaryEntry | null
    inventory: InventoryItem[]
    inventoryExpiryReminders: InventoryExpiryReminder[]
    healthReminders: HealthRecord[]
    weekFeedCount: number
    weekMoodCounts: Record<string, number>
    weekAbnormalPoopCount: number
    todayPoopCount: number
    weekWeightDelta: number | null
}

const EMPTY_DATA: DashboardData = {
    todayFeeds: [],
    todayMood: null,
    monthMoodMap: {},
    latestDiary: null,
    inventory: [],
    inventoryExpiryReminders: [],
    healthReminders: [],
    weekFeedCount: 0,
    weekMoodCounts: { '😸': 0, '😾': 0, '😴': 0 },
    weekAbnormalPoopCount: 0,
    todayPoopCount: 0,
    weekWeightDelta: null,
}

export function useDashboardData(catId: string | null, catLoading: boolean) {
    const { language } = useI18n()
    const pushToast = useToastStore((s) => s.pushToast)
    const [data, setData] = useState<DashboardData>(EMPTY_DATA)
    const [loading, setLoading] = useState(true)
    const [today, setToday] = useState(() => new Date().toISOString().split('T')[0])

    const monthStart = useMemo(() => startOfMonth(new Date(today)), [today])
    const monthEnd = useMemo(() => endOfMonth(new Date(today)), [today])
    const monthDays = useMemo(
        () => eachDayOfInterval({ start: monthStart, end: monthEnd }),
        [monthEnd, monthStart],
    )

    const loadData = useCallback(async () => {
        if (!catId) {
            if (!catLoading) setLoading(false)
            return
        }

        setLoading(true)
        const weekStart = new Date()
        weekStart.setDate(weekStart.getDate() - 6)
        const weekStartIso = `${format(weekStart, 'yyyy-MM-dd')}T00:00:00`

        try {
            const [
                feedRes, moodRes, diaryRes, invRes, invExpiryRes, healthRes,
                weekFeedsRes, weekMoodsRes, weekPoopsRes, weekWeightsRes,
                monthMoodsRes,
            ] = await withTimeout(Promise.all([
                supabase
                    .from('feed_status')
                    .select('*')
                    .eq('cat_id', catId)
                    .gte('fed_at', `${today}T00:00:00`)
                    .order('fed_at', { ascending: false }),
                supabase
                    .from('mood_logs')
                    .select('*')
                    .eq('cat_id', catId)
                    .eq('date', today)
                    .limit(1)
                    .single(),
                supabase
                    .from('diary_entries')
                    .select('*')
                    .eq('cat_id', catId)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .single(),
                supabase.from('inventory').select('*').eq('cat_id', catId),
                supabase
                    .from('inventory_expiry_reminders')
                    .select('*')
                    .eq('cat_id', catId)
                    .is('discarded_at', null)
                    .order('expires_at', { ascending: true }),
                supabase
                    .from('health_records')
                    .select('*')
                    .eq('cat_id', catId)
                    .in('type', ['vaccine', 'deworming'])
                    .not('next_due', 'is', null)
                    .order('next_due', { ascending: true }),
                supabase
                    .from('feed_status')
                    .select('*')
                    .eq('cat_id', catId)
                    .gte('fed_at', weekStartIso),
                supabase
                    .from('mood_logs')
                    .select('*')
                    .eq('cat_id', catId)
                    .gte('created_at', weekStartIso),
                supabase
                    .from('poop_logs')
                    .select('*')
                    .eq('cat_id', catId)
                    .gte('created_at', weekStartIso),
                supabase
                    .from('weight_records')
                    .select('*')
                    .eq('cat_id', catId)
                    .gte('recorded_at', weekStartIso)
                    .order('recorded_at', { ascending: true }),
                supabase
                    .from('mood_logs')
                    .select('*')
                    .eq('cat_id', catId)
                    .gte('date', format(monthStart, 'yyyy-MM-dd'))
                    .lte('date', format(monthEnd, 'yyyy-MM-dd')),
            ]), 15000) // 15s timeout to prevent stuck loading

            const newData: DashboardData = { ...EMPTY_DATA }

            if (feedRes.data) newData.todayFeeds = feedRes.data
            if (moodRes.data) newData.todayMood = moodRes.data.mood
            if (diaryRes.data) newData.latestDiary = diaryRes.data
            if (invRes.data) newData.inventory = invRes.data
            if (invExpiryRes.data) newData.inventoryExpiryReminders = invExpiryRes.data
            if (healthRes.data) newData.healthReminders = healthRes.data
            if (weekFeedsRes.data) newData.weekFeedCount = weekFeedsRes.data.length

            if (weekMoodsRes.data) {
                const counts: Record<string, number> = { '😸': 0, '😾': 0, '😴': 0 }
                weekMoodsRes.data.forEach((item) => { counts[item.mood] += 1 })
                newData.weekMoodCounts = counts
            }

            if (weekPoopsRes.data) {
                newData.weekAbnormalPoopCount = weekPoopsRes.data.filter(
                    (item) => isAbnormalPoop(item.bristol_type, item.color),
                ).length
                newData.todayPoopCount = weekPoopsRes.data.filter(
                    (item) => format(new Date(item.created_at), 'yyyy-MM-dd') === today,
                ).length
            }

            if (weekWeightsRes.data && weekWeightsRes.data.length >= 2) {
                const first = weekWeightsRes.data[0].weight_kg
                const last = weekWeightsRes.data[weekWeightsRes.data.length - 1].weight_kg
                newData.weekWeightDelta = Number((last - first).toFixed(2))
            }

            if (monthMoodsRes.data) {
                const map: Record<string, MoodType> = {}
                monthMoodsRes.data.forEach((entry) => { map[entry.date] = entry.mood })
                newData.monthMoodMap = map
            }

            setData(newData)
        } catch (err) {
            console.error('Failed to load dashboard data:', err)
            pushToast('error', getErrorMessage(err, '数据加载失败，请稍后重试'))
        } finally {
            setLoading(false)
        }
    }, [catId, catLoading, monthEnd, monthStart, today, pushToast])

    useEffect(() => { loadData() }, [loadData])

    // Midnight auto-refresh
    useEffect(() => {
        const scheduleNextMidnight = () => {
            const now = new Date()
            const next = new Date(now)
            next.setHours(24, 0, 2, 0)
            return window.setTimeout(() => {
                setToday(new Date().toISOString().split('T')[0])
            }, next.getTime() - now.getTime())
        }

        const timer = scheduleNextMidnight()
        return () => window.clearTimeout(timer)
    }, [today])

    // Realtime subscriptions — targeted partial reloads
    const reloadFeeds = useCallback(async () => {
        if (!catId) return
        const todayStr = new Date().toISOString().split('T')[0]
        const weekStart = new Date()
        weekStart.setDate(weekStart.getDate() - 6)
        const weekStartIso = `${format(weekStart, 'yyyy-MM-dd')}T00:00:00`

        const [feedRes, weekFeedsRes] = await Promise.all([
            supabase.from('feed_status').select('*').eq('cat_id', catId)
                .gte('fed_at', `${todayStr}T00:00:00`)
                .order('fed_at', { ascending: false }),
            supabase.from('feed_status').select('*').eq('cat_id', catId)
                .gte('fed_at', weekStartIso),
        ])
        setData((prev) => ({
            ...prev,
            todayFeeds: feedRes.data ?? prev.todayFeeds,
            weekFeedCount: weekFeedsRes.data?.length ?? prev.weekFeedCount,
        }))
    }, [catId])

    const reloadMoods = useCallback(async () => {
        if (!catId) return
        const todayStr = new Date().toISOString().split('T')[0]

        const [moodRes, monthMoodsRes] = await Promise.all([
            supabase.from('mood_logs').select('*').eq('cat_id', catId).eq('date', todayStr).limit(1).single(),
            supabase.from('mood_logs').select('*').eq('cat_id', catId)
                .gte('date', format(monthStart, 'yyyy-MM-dd'))
                .lte('date', format(monthEnd, 'yyyy-MM-dd')),
        ])
        setData((prev) => {
            const updated = { ...prev }
            if (moodRes.data) updated.todayMood = moodRes.data.mood
            if (monthMoodsRes.data) {
                const map: Record<string, MoodType> = {}
                monthMoodsRes.data.forEach((entry) => { map[entry.date] = entry.mood })
                updated.monthMoodMap = map
            }
            return updated
        })
    }, [catId, monthStart, monthEnd])

    const reloadInventory = useCallback(async () => {
        if (!catId) return
        const { data: invData } = await supabase.from('inventory').select('*').eq('cat_id', catId)
        if (invData) {
            setData((prev) => ({ ...prev, inventory: invData }))
        }
    }, [catId])

    useRealtimeSubscription('feed_status', () => { reloadFeeds() })
    useRealtimeSubscription('mood_logs', () => { reloadMoods() }, catId ? `cat_id=eq.${catId}` : undefined)
    useRealtimeSubscription('inventory', () => { reloadInventory() })

    // Derived computations
    const lowInventory = useMemo(
        () => data.inventory
            .filter((i) => computeInventoryStatus(i) !== 'plenty' && !isItemActivelySnoozed(i.snoozed_until, today))
            .map((i) => ({
                ...i,
                snoozeInfo: computeSnoozeDisplay(i.snoozed_until, today, language),
            })),
        [data.inventory, today, language],
    )

    const allInventoryExpiryReminders = useMemo(() => {
        return data.inventoryExpiryReminders
            .filter((item) => !isItemActivelySnoozed(item.snoozed_until, today))
            .map((item) => {
                const hoursLeft = computeInventoryExpiryHoursLeft(item)
                const snoozeInfo = computeSnoozeDisplay(item.snoozed_until, today, language)
                return { ...item, hoursLeft, snoozeInfo }
            })
            .sort((a, b) => a.hoursLeft - b.hoursLeft)
    }, [data.inventoryExpiryReminders, today, language])

    const healthReminderItems = useMemo(() => {
        const now = new Date()
        return data.healthReminders.map((r) => {
            const daysLeft = differenceInDays(new Date(r.next_due!), now)
            const snoozeInfo = computeSnoozeDisplay(r.snoozed_until, today, language)
            return { ...r, daysLeft, snoozeInfo }
        })
    }, [data.healthReminders, today, language])

    const urgentHealthReminders = useMemo(
        () => healthReminderItems.filter((r) => r.daysLeft <= 3 && !isItemActivelySnoozed(r.snoozed_until, today)),
        [healthReminderItems, today],
    )

    const catCountdowns = useMemo(() => {
        // Reusable — no need for Dashboard component to re-derive this
        return { daysHome: null as number | null, daysToBirthday: null as number | null }
    }, [])

    return {
        data,
        loading,
        today,
        monthDays,
        lowInventory,
        allInventoryExpiryReminders,
        healthReminderItems,
        urgentHealthReminders,
        reload: loadData,
        setTodayMood: (mood: MoodType | null) => setData((prev) => ({ ...prev, todayMood: mood })),
        setTodayFeeds: (feeds: FeedStatus[]) => setData((prev) => ({ ...prev, todayFeeds: feeds })),
        catCountdowns,
    }
}
