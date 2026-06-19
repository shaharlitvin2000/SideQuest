# 🚀 Quick Start - Deploy Security Fixes (15 minutes)

## **Step 1: Install Firebase CLI** (2 min)
```bash
npm install -g firebase-tools
firebase login
```

## **Step 2: Delete Exposed API Key** (1 min) ⚠️ CRITICAL
1. Go to: https://console.cloud.google.com/apis/credentials
2. Find and DELETE: `AIzaSyBzXMaQ_jk5HcXUZBP8Haj9eiGkaCpHVfE`
3. Done ✅

## **Step 3: Deploy Cloud Functions** (5 min)
```bash
cd firebase/functions
npm install
cd ../..
firebase deploy --only functions
```

**Wait for success message:** "Deploy complete!"

## **Step 4: Deploy Updated Rules & Code** (3 min)
```bash
firebase deploy --only database,storage,hosting
```

**Wait for success message:** "Deploy complete!"

## **Step 5: Test It Works** (2 min)
1. Open: https://flasharena-f35b1.web.app
2. Create account
3. Complete a mission → Should work ✅
4. Try to complete same mission again → Should fail ✅
5. Go to leaderboard → Should load ✅

**If any step fails:** Check browser console (F12) or Firebase logs

## **Done! You're Secure** 🔒

---

## **WHAT WAS FIXED**

✅ Exposed API key removed  
✅ Points cannot be manipulated  
✅ Missions can't be replayed  
✅ Content moderated server-side  
✅ Users can't like/follow twice  
✅ 30-minute session timeout  
✅ Password strength required  
✅ Comments rate-limited  

---

## **IF SOMETHING BREAKS**

### "Permission denied on all operations"
→ Rules deployed correctly, but Cloud Functions might not be working
→ Check: Firebase Console → Functions → Logs

### "Functions not found"  
→ Functions didn't deploy
→ Run: `firebase deploy --only functions`

### "Missions won't complete"
→ Check browser console (F12 → Console)
→ Should see: `Cloud Function completeMission returned: {success: true}`

### Still broken?
→ Run the full guide: `DEPLOYMENT_GUIDE_SECURITY.md`

---

**All set!** Your app is now much more secure. 🎉
