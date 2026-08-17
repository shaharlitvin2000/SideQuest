package com.sidequest.app;

import android.graphics.Color;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            String versionName = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setUserAgentString(settings.getUserAgentString() + " SideQuestNative/" + versionName);
        } catch (Exception e) {
            // Non-fatal — the web layer just won't find a native version marker.
        }
        try {
            // Confirmed live on-device (Samsung One UI, gesture nav): Capacitor's SystemBars
            // plugin calls WindowInsetsControllerCompat.setAppearanceLightNavigationBars(false)
            // for both status and nav bars — the status bar call is honored (its
            // APPEARANCE_LIGHT_STATUS_BARS bit correctly clears in SystemUI's own log), but the
            // nav bar's APPEARANCE_LIGHT_NAVIGATION_BARS bit stays set regardless — a real,
            // OEM-specific asymmetry, not a config or wiring bug. Falling back to the older,
            // AOSP-deprecated-for-API-35+ direct color API as a second, redundant path — Samsung's
            // SystemUI fork may still honor it even where the modern appearance-flag API is being
            // ignored for the nav bar specifically.
            getWindow().setNavigationBarColor(Color.parseColor("#0D0D10"));
        } catch (Exception e) {
            // Non-fatal — worst case, no change from the SystemBars-only behavior.
        }

        // The web layer is a single-page app with zero browser history (go()/showPage() just
        // toggle CSS classes, never push state), so Capacitor's default back handling —
        // webView.canGoBack() ? goBack() : finish() — always fell through to finish(), exiting
        // the app from any screen. Ask the page's own _handleAndroidBack() whether it closed an
        // overlay or navigated back to Home instead; only background the app if it says there
        // was nothing left to do there.
        //
        // Registered via OnBackPressedDispatcher rather than overriding onBackPressed(): on
        // devices with the predictive-back API active, the system dispatches through
        // Activity.onBackInvoked() to a synthetic default callback that does NOT call an
        // overridden onBackPressed() — confirmed live on-device (logcat showed onBackInvoked
        // firing and the app backgrounding with an open modal still on screen, never reaching
        // this logic). Registering a real OnBackPressedCallback is the path the dispatcher
        // actually invokes on both legacy and predictive-back devices.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                try {
                    getBridge().getWebView().evaluateJavascript(
                        "(function(){try{return !!(window._handleAndroidBack && window._handleAndroidBack());}catch(e){return false;}})();",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (!"true".equals(value)) {
                                    moveTaskToBack(true);
                                }
                            }
                        }
                    );
                } catch (Exception e) {
                    moveTaskToBack(true);
                }
            }
        });
    }
}
