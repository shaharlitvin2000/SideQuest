# 📊 Monitoring & Maintenance Guide

**Version:** 2.0 | **Updated:** 2026-06-04

---

## **Dashboard Access**

### Admin Dashboard
```
URL: https://flasharena-f35b1.web.app/admin-dashboard.html
Requires: Admin email login
Purpose: Manage content, users, view stats
```

### Firebase Console
```
URL: https://console.firebase.google.com
Project: flasharena-f35b1
Purpose: System health, logs, backups
```

### Sentry Dashboard
```
URL: https://sentry.io
Purpose: Error tracking and monitoring
```

---

## **DAILY MONITORING (5 minutes)**

### 1. Check Firebase Logs
```
Firebase Console → Functions → Logs
```

**What to Look For:**
- ❌ **Red lines** = Errors (investigate immediately)
- ⚠️ **Yellow lines** = Warnings (usually ok)
- ✅ **Blue lines** = Info (normal)
- 📍 **[Abuse]** entries = Normal, expected entries

**Example Normal Log:**
```
[Abuse] User abc123 blocked - score: 52, reasons: ["like","like","like"]
```

**Example Bad Log:**
```
Error: Cannot read property 'username' of null
```

**Action If Error Found:**
1. Note the timestamp and error message
2. Check: Is the function failing for all users or just one?
3. Check: Did I recently deploy something?
4. Solution: Check COMPLETE_SETUP_GUIDE.md → Troubleshooting

### 2. Check Sentry
```
Sentry.io → Issues
```

**What to Look For:**
- Any new errors since yesterday?
- Error count increasing?
- Same error appearing repeatedly?

**Action If Issue Found:**
1. Click the issue to see full stack trace
2. Note which function/file is failing
3. Check Firebase logs for more context
4. If can't fix: Note in JIRA or your todo

### 3. Quick Stats Check
```
Firebase Console → Realtime Database → Overview
```

**Metrics to Monitor:**
- **Connections**: Should be increasing (or stable if off-peak)
- **Read/Write Ops**: Should be normal (not spiking)
- **Data Size**: Should grow ~1-5% per day (depends on users)

---

## **WEEKLY MONITORING (30 minutes)**

### 1. Admin Dashboard Deep Dive

**Overview Tab:**
```
Check:
- Total users: Increasing as expected?
- Active users (24h): >30% of total is good
- Total posts: Growing steadily?
- Blocked users: Any unexpected high numbers?
```

**Expected Growth (Weekly):**
- Users: +10-20% (early stage)
- Posts: +2-5x (depends on user count)
- Engagement: Likes/comments should increase

**Action If Unusual:**
- If users ↑ but posts ↓: Feature issue? Check Sentry
- If blocked users ↑↑↑: Abuse score too sensitive? Consider raising threshold
- If users ↓: User churn? Check if missions too hard or app buggy

**Content Moderation Tab:**
```
Check:
- Any posts showing "rejected" status?
- What's the rejection reason?
- Are there false positives?
```

**Example Actions:**
- See "hate speech" rejection? Check if legitimate
- See multiple from same user? Consider warning them
- Too many false positives? Adjust keyword list

**Users Tab:**
```
Check:
- Any users with "blocked" = true?
- Why are they blocked (look at database)?
- Should we unblock anyone?
```

**Example Actions:**
- If user blocked due to "2 bad uploads": Consider warning first
- If user blocked due to high abuse score: Wait 1 hour (auto-resets)
- If user legitimately harassing: Keep blocked

### 2. Database Health Check

```
Firebase Console → Realtime Database → Data Size
```

**What to Check:**
- Growth rate normal? (1-5% per week)
- Any large spikes? (means corruption or bug)
- Storage usage? ($ cost implications)

**Reference Costs (at 1000 users):**
- 0-1GB: ~$5/month
- 1-10GB: ~$10-20/month
- 10GB+: Consider archive/cleanup

### 3. Abuse Tracking

**Firebase Console → Realtime Database → browse → (users)**

Look for patterns:
- Who's getting blocked most often?
- What actions trigger blocks? (likes, comments, follows)
- Any IP addresses with many accounts?

**Review in Database:**
```
Go to: Realtime Database → Data
Expand: users → [pick a user] → look for:
- badUploads: count (auto-blocks at 2)
- blocked: true/false (manual or auto)
```

---

## **MONTHLY MONITORING (1 hour)**

### 1. Performance Analysis

**Firebase Console → Realtime Database → Rules Tab**
- Any rule violations in logs?
- Any performance warnings?

**Sentry → Performance**
- Which functions are slowest?
- Any memory leaks?
- Any database query timeouts?

### 2. User Feedback Review

**Admin Dashboard → Feedback Tab**
- Read all user reports
- Any common complaints?
- Any serious issues?

**Action Items:**
- Bug reported: Create ticket to fix
- Feature request: Add to roadmap
- Complaint about blocking: Review user's case

### 3. Security Audit

**Check:**
- Any attempted exploits in logs?
- Any unusual data patterns?
- Any failed auth attempts?

**Firebase Console → Authentication**
- How many users created this month?
- Any accounts with unusual activity?
- Any disabled accounts?

### 4. Growth Metrics

```
Create a simple table:

| Metric | Last Month | This Month | Growth |
|--------|-----------|-----------|--------|
| Users  | 500 | 600 | +20% ✅ |
| Posts  | 2000 | 3000 | +50% ✅ |
| Active | 150 | 180 | +20% ✅ |
| Blocked | 2 | 15 | +650% ⚠️ |
```

**Analysis:**
- If growth slowing: Retention issue? Market saturation?
- If blocked users ↑: Abuse increasing? Thresholds too strict?
- If active users ↑ slower than total: Churn happening

---

## **QUARTERLY REVIEW (2 hours)**

### 1. System Health Report
- Uptime: Should be 99.9%+ (Firebase auto-scales)
- Error rate: Should be <0.1%
- Average latency: Should be <200ms
- User satisfaction: Are complaints decreasing?

### 2. Business Metrics
- DAU (Daily Active Users): Trending up?
- Missions completed: Are people engaging?
- Points distributed: Fair or inflated?
- Content quality: Is moderation working?

### 3. Technical Debt
- Any code that needs refactoring?
- Any slow queries?
- Any security improvements needed?
- Any dependency updates?

### 4. Planning
- Phase 3 features to build?
- Any known bugs to fix?
- Infrastructure improvements?
- Team hiring needed?

---

## **ALERT THRESHOLDS**

Set these alerts in Firebase & Sentry:

| Event | Threshold | Action |
|-------|-----------|--------|
| Function error rate | >1% | Check immediately |
| Function timeout | >10 | Review code |
| Database quota | >80% | Plan upgrade |
| Storage quota | >80% | Clean up or upgrade |
| Sentry error spike | >10x normal | Investigate |
| Failed logins | >100/hour | Check security |
| Blocked users | >5% of daily signups | Review thresholds |

---

## **Common Issues & Solutions**

### Issue: Error Rate Spiking
```
Symptoms: Sentry shows 10+ errors in 1 hour
Causes: 
  - New code deployed with bug
  - Cloud Function timeout
  - Database rate limit hit

Solution:
1. Check Firebase logs for errors
2. Look at deployment history (did I just deploy?)
3. Check Sentry for error type (same error repeated?)
4. Rollback if needed: firebase deploy --only hosting
```

### Issue: Users Getting Blocked Incorrectly
```
Symptoms: Admin complains "legitimate user blocked"
Cause: Abuse detection too sensitive

Solution:
1. Check user's abuse score in database
2. Look at reasons array: was it legitimate action?
3. If false positive: Delete from abuseScores map
4. Consider raising threshold (currently 50 points)
```

### Issue: Slow Performance
```
Symptoms: Page loading slowly, functions timing out
Causes:
  - Too many read ops
  - Large database queries
  - Cold function startup

Solution:
1. Check Sentry → Performance tab
2. Which function is slowest?
3. Add caching if possible
4. Optimize database queries
5. Consider read replicas (Phase 3)
```

### Issue: Storage Running Out
```
Symptoms: Firebase Console shows >80% storage used
Cause: Old posts/videos never deleted

Solution:
1. Run: firebase functions:log → look for cleanup job
2. Manually delete old posts: firebase database:remove /feed --from-timestamp [date]
3. Clean old backup files
4. Set retention policy: Only keep 90 days of data
```

---

## **Maintenance Scripts**

### Backup Database
```bash
# Manual backup
firebase database:get / -r flasharena-f35b1 > backup-$(date +%Y%m%d).json

# Restore from backup
firebase database:set / -r flasharena-f35b1 < backup-20260604.json
```

### Clean Old Data
```bash
# Remove posts older than 30 days (⚠️ be careful!)
firebase database:remove /feed --from-timestamp $(date -d '30 days ago' +%s)000
```

### Monitor Function Performance
```bash
# Real-time logs
firebase functions:log

# Logs from specific function
firebase functions:log --limit 50
```

---

## **Team Communication**

### Weekly Status Email
```
Subject: Flash Arena - Weekly Status

Users: 600 → 620 (+3%)
Active: 180 → 195 (+8%)
Posts: 3000 → 3500 (+17%)
Blocked: 15 → 16 (+1)
Errors: 0 critical
Feedback: [2 positive, 1 bug report]

Action Items This Week:
- [ ] Fix [bug name]
- [ ] Review [user report]
- [ ] Optimize [slow function]

Next Week Priorities:
1. [Feature X]
2. [Bug fix Y]
```

### Post-Outage Report
```
Issue: Users couldn't complete missions for 5 minutes
Cause: Cloud Function temporarily down
Impact: ~20 failed attempts
Fix: Redeployed functions
Prevention: Added alerting
Status: ✅ RESOLVED
```

---

## **Quick Reference**

### Emergency Contacts
- Firebase Support: console.firebase.google.com → Help
- Sentry Support: sentry.io → Help icon
- Email: admin@flasharena.com

### Common Commands
```bash
# Deploy everything
firebase deploy --only functions,database,storage,hosting

# Check deployment status
firebase deploy:list

# View logs
firebase functions:log

# Get database statistics
firebase database:instances:describe flasharena-f35b1
```

### Important URLs
```
Admin Dashboard: https://flasharena-f35b1.web.app/admin-dashboard.html
Firebase: https://console.firebase.google.com/project/flasharena-f35b1
Sentry: https://sentry.io/organizations/[your-org]/
```

---

**Remember:** Proactive monitoring prevents most problems. Check logs daily!

*Last updated: 2026-06-04*
