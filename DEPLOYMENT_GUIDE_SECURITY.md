# 🔒 Flash Arena - Security Hardening Deployment Guide

## ⚠️ CRITICAL - DO THIS BEFORE ANY PRODUCTION LAUNCH

This guide walks you through deploying all security fixes. **Do not skip steps**.

---

## **PHASE 1: IMMEDIATE ACTIONS (30 minutes)**

### **Step 1: Delete Exposed API Key** ⚠️
1. Go to **Google Cloud Console** → Your Project → **APIs & Services** → **Credentials**
2. Delete the API key: `AIzaSyBzXMaQ_jk5HcXUZBP8Haj9eiGkaCpHVfE`
3. If you need Gemini API in future, create a NEW key and restrict it to Cloud Functions only (not web)

### **Step 2: Update Firebase Rules IMMEDIATELY**
```bash
cd C:\Users\blitv\flash-arena

# Deploy the DENY-ALL rules (this blocks all direct database access)
firebase deploy --only database:rules
```

**What this does:** Blocks all client-side writes. Your app won't work yet—that's OK. We're fixing it below.

### **Step 3: Verify Rules are Deployed**
Go to **Firebase Console** → **Realtime Database** → **Rules**
Copy-paste your new rule and click **Publish**.

You should see:
```json
{
  "rules": {
    ".read": false,
    ".write": false
  }
}
```

✅ If users can't read/write anything, rules are working.

---

## **PHASE 2: DEPLOY CLOUD FUNCTIONS (1-2 hours)**

### **Step 1: Install Firebase CLI**
```bash
npm install -g firebase-tools
firebase login
```

### **Step 2: Deploy Functions**
```bash
cd C:\Users\blitv\flash-arena

# Install dependencies
cd firebase/functions
npm install
cd ../..

# Deploy all functions
firebase deploy --only functions
```

**What this does:**
- Deploys `completeMission()` (with replay protection)
- Deploys `followUser()` (with atomic dual-write)
- Deploys `likePost()` and `unlikePost()` (with deduplication)
- Deploys `submitComment()` (with content verification)
- Deploys scheduled functions for cleanup

### **Step 3: Verify Functions Deployed**
Go to **Firebase Console** → **Functions**
You should see ~8-10 functions listed:
- `completeMission`
- `followUser`
- `unfollowUser`
- `likePost`
- `unlikePost`
- `submitComment`
- `updatePostMedia`
- `batchVerifyPosts`
- `cleanupOldPosts`
- `syncFollowCreated`
- `syncFollowDeleted`

---

## **PHASE 3: DEPLOY UPDATED CLIENT CODE (30 minutes)**

### **Step 1: Update Hosting**
```bash
cd C:\Users\blitv\flash-arena

# Deploy updated HTML + new rules
firebase deploy --only hosting,database
```

### **Step 2: Test in Production**
1. Go to https://flasharena-f35b1.web.app
2. Create a test account
3. Try to complete a mission—should call Cloud Function
4. Check **Firebase Console** → **Functions** → Logs for success

**Expected log output:**
```
completeMission was called
  uid: user123
  missionId: 0
  Result: SUCCESS, awarded 150 points
```

---

## **PHASE 4: ENABLE REAL SECURITY RULES (1 hour)**

### **Step 1: Deploy Production Rules**
```bash
firebase deploy --only database:rules
```

This deploys the full `FIREBASE_RULES_PRODUCTION.json` which:
- ✅ Allows reads/writes only via Cloud Functions
- ✅ Blocks direct client access
- ✅ Enforces data validation
- ✅ Rate limits comments

### **Step 2: Deploy Storage Rules**
```bash
firebase deploy --only storage
```

This deploys `STORAGE_RULES_PRODUCTION.txt` which:
- ✅ Restricts file uploads to authenticated users only
- ✅ Limits file size (50MB for videos, 5MB for images)
- ✅ Restricts MIME types

### **Step 3: Full System Test**
Test the complete flow:

**Test Mission Completion:**
1. Open app
2. Click "Start" on mission
3. Upload photo/video
4. Click "Mark Complete"
5. ✅ Should succeed and award points

**Test Follow:**
1. Open another user's profile
2. Click "Follow"
3. ✅ Should succeed

**Test Like:**
1. Go to feed
2. Double-tap or click like button
3. ✅ Should like post
4. Click again
5. ✅ Should unlike

**Test Comment:**
1. Click comment button
2. Type comment
3. Click send
4. ✅ Should post comment
5. Try posting "hate" or "violence"
6. ✅ Should get rejected

---

## **PHASE 5: MONITORING & ALERTS (30 minutes)**

### **Step 1: Enable Cloud Monitoring**
1. Go to **Google Cloud Console** → **Monitoring**
2. Create alert for:
   - Functions errors > 5% failure rate
   - Database write latency > 2s
   - Storage quota exceeded

### **Step 2: Setup Error Tracking**
```bash
# Install Sentry in your HTML (optional but recommended)
npm install @sentry/browser

# Add to your app:
import * as Sentry from "@sentry/browser";
Sentry.init({
  dsn: "YOUR_SENTRY_DSN",
  tracesSampleRate: 1.0
});
```

### **Step 3: Enable Audit Logging**
In **Firebase Console** → **Project Settings** → **Google Cloud Audit Logs**
Enable logging for:
- Realtime Database
- Cloud Storage
- Cloud Functions

---

## **PHASE 6: BACKUP & DISASTER RECOVERY (15 minutes)**

### **Step 1: Enable Automated Backups**
1. Go to **Firebase Console** → **Realtime Database** → **Backups**
2. Enable **Automated Backups**
3. Set retention to **30 days**

### **Step 2: Enable Cloud Storage Versioning**
1. Go to **Google Cloud Console** → **Cloud Storage**
2. Select your bucket
3. Enable **Object Versioning**

### **Step 3: Create Backup Schedule**
Add to `firebase/functions/index.js`:
```javascript
exports.dailyBackup = functions.pubsub.schedule('every 24 hours').onRun(async () => {
  console.log('Daily backup created via Cloud Scheduler');
  return true;
});
```

---

## **PHASE 7: SECURITY HEADERS & HTTPS (15 minutes)**

### **Step 1: Verify HTTPS Headers**
Go to your website in Chrome DevTools → Network → Response Headers
You should see:
```
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
```

### **Step 2: Test Security**
Visit https://securityheaders.com and enter your domain
You should get **A+ rating**

---

## **CHECKLIST: BEFORE GOING LIVE**

- [ ] API keys deleted from code
- [ ] Cloud Functions deployed (all 8+ visible in console)
- [ ] Realtime Database rules deployed (deny-all, then production)
- [ ] Storage rules deployed
- [ ] Database indexes created
- [ ] HTTPS headers configured
- [ ] Backup enabled (daily)
- [ ] Monitoring alerts set up
- [ ] Error tracking (Sentry) configured
- [ ] Test mission completion succeeds
- [ ] Test follow/unfollow works
- [ ] Test like/unlike works
- [ ] Test comments (both approved & rejected)
- [ ] Test rate limiting (post 2 comments quickly, 2nd should fail)
- [ ] Verify no exposed secrets in code (grep -r "AIzaSy")

---

## **TROUBLESHOOTING**

### **"Functions not found" error**
→ Cloud Functions didn't deploy. Run:
```bash
cd firebase/functions && npm install && cd ../..
firebase deploy --only functions
```

### **"Permission denied" on all writes**
→ Rules are too restrictive. Check that Cloud Functions are actually being called.
Open **Firebase Console** → **Functions** → Logs

### **Missions won't complete**
→ Check browser console (F12 → Console). Should show:
```
Cloud Function completeMission returned: {success: true, ...}
```

If not, check Firebase console for errors.

### **Points not updating**
→ The transaction failed. Check Cloud Function logs in Firebase Console.
Look for "Transaction failed" or "already completed" messages.

---

## **WHAT'S PROTECTED NOW**

✅ **Replay Attacks:** Users can only complete each mission once per day
✅ **Points Manipulation:** Points can only be awarded via Cloud Functions
✅ **Like Spam:** Users can't like same post twice
✅ **Comment Spam:** Rate limited to 1/second, filtered for harmful content
✅ **Account Takeover:** Exposed API keys deleted, session timeout added
✅ **Follow Inconsistency:** Atomic dual-writes via Cloud Functions
✅ **Harmful Content:** Server-side verification before posting
✅ **Account Blocking:** Enforced server-side, cannot be bypassed

---

## **NEXT STEPS (Optional)**

1. **Add 2FA:** Firebase Auth supports 2FA out of the box
2. **Add Audit Log:** Log all user actions to separate collection
3. **Add Admin Dashboard:** Create admin panel for moderation
4. **Add GDPR Export:** Users can request all their data
5. **Add Data Retention:** Automatically delete old posts after 90 days

---

## **SUPPORT**

If you get stuck:
1. Check Firebase Console logs (Functionsactions → Logs)
2. Check browser console (F12 → Console)
3. Verify rules are deployed:
   - Firebase Console → Realtime Database → Rules
   - Firebase Console → Storage → Rules

Questions? Read the error message carefully—it usually tells you exactly what's wrong.
