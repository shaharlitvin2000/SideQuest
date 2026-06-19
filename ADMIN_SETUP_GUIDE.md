# 🔧 Admin Setup & Configuration Guide

**Version:** 2.0 | **Date:** 2026-06-04

---

## **Step 1: Configure Admin Emails**

### In `admin-dashboard.html`

Find line ~180:
```javascript
let adminUsers = new Set(['admin@flasharena.com']);
```

Replace with YOUR email (or multiple admins):
```javascript
// Single admin
let adminUsers = new Set(['your.email@gmail.com']);

// Multiple admins
let adminUsers = new Set([
  'admin1@company.com',
  'admin2@company.com',
  'support@company.com'
]);
```

### Deploy It
```bash
firebase deploy --only hosting
```

### Test It
1. Go to: `https://flasharena-f35b1.web.app/admin-dashboard.html`
2. Login with your admin email
3. Should see: "Overview", "Content Moderation", "Users", "Feedback" tabs
4. If permission denied: Check email in adminUsers

---

## **Step 2: Configure Sentry (Error Tracking)**

### Why Sentry?
- Catches bugs before users report them
- Real-time error notifications
- Stack traces for debugging
- Performance monitoring

### Setup (5 minutes)

**2a. Create Sentry Account**
1. Go to: https://sentry.io
2. Sign up (free tier is fine)
3. Create organization
4. Create project → Select "JavaScript"

**2b. Copy Your DSN**
1. In Sentry, go to: Settings → Projects → YourProject → Client Keys (DSN)
2. Copy the DSN (looks like: `https://xxx@yyy.ingest.sentry.io/123456`)

**2c. Add to Flash Arena**
1. Open: `flash-arena.html`
2. Find line ~854:
```javascript
const SENTRY_DSN='YOUR_SENTRY_DSN_HERE';
```
3. Replace with your actual DSN:
```javascript
const SENTRY_DSN='https://abc123@xxx.ingest.sentry.io/987654';
```
4. Save & deploy:
```bash
firebase deploy --only hosting
```

**2d. Test It**
1. Open: https://flasharena-f35b1.web.app
2. Open DevTools (F12)
3. Type: `throw new Error('Test error')`
4. Press Enter
5. Wait 30 seconds
6. Check Sentry dashboard → Issues
7. Should see "Test error"

### Sentry Dashboard
- **Issues tab:** All errors that happened
- **Performance tab:** Slow requests
- **Release tab:** Track deployments

---

## **Step 3: Database Backup**

### Automatic Backups
Firebase keeps automatic backups, but let's make one now before launch.

**Via Firebase Console:**
1. Go to: Firebase Console → Realtime Database
2. Click: "Backups" tab (top right)
3. Click: "Create Backup"
4. Wait for completion (1-5 minutes)
5. ✅ Done - You have a restore point

**Restore If Needed:**
1. Go to: Backups tab
2. Click the backup
3. Click: "Restore"
4. Confirm (⚠️ This will overwrite current data)

---

## **Step 4: Enable Firebase Backups (Automated)**

For peace of mind, enable daily backups:

1. Firebase Console → Realtime Database → Backups
2. If available: Set to "Daily" or "Weekly"
3. ✅ Automatic backups enabled

*Note: This may cost extra ($2-5/month). Free tier gets 1 manual backup.*

---

## **Step 5: Set Up Monitoring Alerts (Optional)**

### Firebase Alerts
1. Firebase Console → Settings → Integrations
2. Email alerts (when quota exceeded, crashes, etc.)
3. Set email to: your admin email

### Sentry Alerts
1. Sentry Dashboard → Alerts
2. Create alert for: "Error rate > 5%"
3. Notify: your email
4. ✅ Alerts enabled

---

## **Step 6: Verify All Systems Before Launch**

### Checklist

**Firebase Console**
- [ ] Database rules are deny-all? (Realtime Database → Rules)
- [ ] Storage rules restrictive? (Storage → Rules)
- [ ] Cloud Functions deployed? (Functions → Should see 13)
- [ ] No function errors? (Functions → Logs)

**Email System**
- [ ] Admin emails configured? (admin-dashboard.html line 180)
- [ ] Test admin login works? (Try login with your admin email)

**Error Tracking**
- [ ] Sentry DSN added? (flash-arena.html line 854)
- [ ] Sentry test worked? (Check Sentry Issues tab)
- [ ] Team invited to Sentry? (Add other admins)

**Backup**
- [ ] Database backup created? (Firebase → Backups)
- [ ] Know how to restore? (Read restore instructions above)

---

## **Step 7: Final Security Check**

### Delete API Key (CRITICAL)
```
⚠️ DO THIS FIRST ⚠️
```

1. Go to: https://console.cloud.google.com/apis/credentials
2. Select project: `flasharena-f35b1`
3. Find API Key: `AIzaSyBzXMaQ_jk5HcXUZBP8Haj9eiGkaCpHVfE` (or similar)
4. Click the key → Delete
5. Wait 2-3 minutes for propagation
6. ✅ Done - Key is now useless

### Verify Deletion
Search GitHub for your API key:
```
site:github.com "AIzaSyBzXMaQ_jk5HcXUZBP8Haj9eiGkaCpHVfE"
```
Should return: 0 results (or your original repo with notice)

---

## **Step 8: Admin Daily Tasks**

### Every Day
1. Check Firebase logs:
   - Firebase Console → Functions → Logs
   - Look for errors (red text)
   - Look for "[Abuse]" blocks (normal)

2. Check Sentry:
   - Sentry.io → Issues
   - Any new errors today?
   - Any error spikes?

### Every Week
1. Admin Dashboard:
   - Overview tab: Check stats (users, posts, engagement)
   - Moderation tab: Review/delete harmful posts
   - Users tab: Check blocked users (any false positives?)
   - Feedback tab: Read user feedback

2. Database:
   - Firebase Console → Realtime Database → Size
   - Storage → Usage
   - Is it growing as expected?

### Every Month
1. Review metrics:
   - User growth: 10% expected?
   - Engagement: Posts per day increasing?
   - Retention: Users returning?

2. Analyze abuse patterns:
   - Who's getting blocked most?
   - Why (specific action)?
   - Any tuning needed?

3. Backup test:
   - Create a test backup
   - Verify it was created successfully

---

## **Step 9: Troubleshooting**

### "Admin dashboard shows permission denied"
**Solution:**
1. Verify your email is in `adminUsers` set
2. Check email spelling (case-sensitive for comparison)
3. Make sure you're logged in with that email
4. Firebase Console → Authentication → Users → Verify your email exists
5. Try logout & login again

### "Sentry not receiving errors"
**Solution:**
1. Check DSN is correct (paste from Sentry exactly)
2. Open DevTools (F12) → Network tab
3. Look for requests to `sentry.io` (should see POST)
4. If no requests: DSN wrong, reload app
5. If requests but no issues: Check Sentry project is correct

### "Can't login to admin dashboard"
**Solution:**
1. Check email verification first (Sentry/Email required)
2. Verify email from: Firebase Console → Authentication → Users → Click user → Email Verified
3. If not verified: Check inbox for verification email
4. If no email: Resend from: Firebase Console → Authentication → Users → Click user → Send verification email

### "Abuse detection blocking legitimate users"
**Solution:**
1. Check their abuse score: Firebase Console → Database → abuseScores → {uid}
2. Check reason: Look at "reasons" array
3. If false positive: Wait 1 hour (score resets) or manually reset
4. To reset: Firebase Console → Realtime Database → abuseScores → Delete user's entry

---

## **Step 10: Contact & Support**

### For Firebase Issues
- Firebase Console → Help & Support (bottom left)
- Check status: status.firebase.google.com

### For Sentry Issues
- Sentry Documentation: docs.sentry.io
- Sentry Support: Help icon in bottom right

### For Flash Arena Issues
- Check: COMPLETE_SETUP_GUIDE.md (troubleshooting)
- Check logs: Firebase Console → Functions → Logs
- Check errors: Sentry Dashboard → Issues

---

## **Quick Reference Commands**

```bash
# Deploy everything
firebase deploy --only functions,database,storage,hosting

# Deploy only hosting (after changing admin email)
firebase deploy --only hosting

# View function logs live
firebase functions:log

# View database rules
firebase database:get / -r flasharena-f35b1

# Backup database
firebase database:get / -r flasharena-f35b1 > backup.json

# Check deployment status
firebase deploy:list
```

---

## **Admin Email Templates**

### For Team
```
Subject: Flash Arena - Admin Dashboard Access

Hi [name],

You've been added as an admin for Flash Arena.

Admin Dashboard: https://flasharena-f35b1.web.app/admin-dashboard.html

Your email: [email]

Tasks:
1. Login with your email
2. Bookmark the admin dashboard
3. Review daily: https://sentry.io (errors)
4. Review weekly: Content moderation tab (harmful posts)

Questions? Check: ADMIN_SETUP_GUIDE.md
```

### To Users (on blocking)
```
Subject: Flash Arena - Account Review

Hi [username],

Your account triggered our safety system. This is usually temporary.

Why? You performed too many actions too quickly (spam detection).

Solution: Wait 1 hour, then try again. Abuse score resets hourly.

Questions? Reply to this email.

- Flash Arena Team
```

---

**Setup Complete!** ✅

You're now ready to:
- ✅ Monitor errors (Sentry)
- ✅ Manage content (Admin Dashboard)
- ✅ Backup data (Firebase Backups)
- ✅ Alert team members
- ✅ Handle user support

**Next:** Deploy with DEPLOYMENT_CHECKLIST.md

---

*Last updated: 2026-06-04*
*Version: 2.0*
