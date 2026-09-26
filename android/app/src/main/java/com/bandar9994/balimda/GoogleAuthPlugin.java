// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

package com.bandar9994.balimda;

import android.accounts.Account;
import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.auth.api.identity.RevokeAccessRequest;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Google sign-in for Drive sync, using Google Play services' account picker.
 * Balimda only asks for its own hidden app folder in Drive (drive.appdata).
 * Play services keeps the grant and renews access tokens, so nothing secret
 * is stored by the app.
 *
 * Google recognises the app by its package name and signing certificate
 * (an "Android" OAuth client in Google Cloud), so no client id is needed here.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {

    private static final String DRIVE_APPDATA = "https://www.googleapis.com/auth/drive.appdata";
    private static final List<Scope> SCOPES = Collections.singletonList(new Scope(DRIVE_APPDATA));

    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;

    @Override
    public void load() {
        launcher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::onResult);
    }

    /** { interactive: boolean } -> { accessToken } */
    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(SCOPES).build();
        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    resolveWith(call, result);
                    return;
                }
                if (!interactive || result.getPendingIntent() == null) {
                    call.reject("Sign in to Google again in Settings → Sync.", "NEEDS_SIGN_IN");
                    return;
                }
                if (pending != null) pending.reject("Google sign-in was restarted.", "CANCELLED");
                pending = call;
                launcher.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
            })
            .addOnFailureListener(e -> reject(call, e));
    }

    private void onResult(ActivityResult activityResult) {
        PluginCall call = pending;
        pending = null;
        if (call == null) return;
        // Google also closes this screen by itself when something is set up
        // wrong, so read its answer rather than assuming the user cancelled.
        Intent data = activityResult.getData();
        if (data == null) {
            if (activityResult.getResultCode() == Activity.RESULT_OK) call.reject("Google sign-in failed. Try again.");
            else call.reject("Google sign-in was closed before it finished. If you didn't close it, check that your Google account is a test user of the app.", "CANCELLED");
            return;
        }
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(data);
            resolveWith(call, result);
        } catch (ApiException e) {
            reject(call, e);
        }
    }

    private void resolveWith(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null) {
            call.reject("Google did not return an access token. Try again.");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("accessToken", token);
        call.resolve(ret);
    }

    private void reject(PluginCall call, Exception e) {
        if (e instanceof ApiException) {
            int status = ((ApiException) e).getStatusCode();
            if (status == CommonStatusCodes.DEVELOPER_ERROR) {
                call.reject("Google sign-in is not set up for this copy of the app (code 10). In Google Cloud, the Android client needs package com.bandar9994.balimda and this app's SHA-1 fingerprint, in the same project as the consent screen.", "DEVELOPER_ERROR", e);
                return;
            }
            if (status == CommonStatusCodes.NETWORK_ERROR) {
                call.reject("No internet connection.", "NETWORK", e);
                return;
            }
            if (status == CommonStatusCodes.CANCELED || status == 12501) {
                call.reject("Google sign-in was cancelled (code " + status + ").", "CANCELLED", e);
                return;
            }
            String detail = e.getMessage() != null ? e.getMessage() : "";
            call.reject("Google sign-in failed (code " + status + "). " + detail, String.valueOf(status), e);
            return;
        }
        call.reject(e.getMessage() != null ? e.getMessage() : "Google sign-in failed.", e);
    }

    /** { token } Forget a cached access token that Google Drive rejected. */
    @PluginMethod
    public void clearToken(PluginCall call) {
        String token = call.getString("token");
        background.execute(() -> {
            try {
                if (token != null) GoogleAuthUtil.clearToken(getContext(), token);
            } catch (Exception ignored) {
                // a token that can't be cleared will simply expire
            }
            call.resolve();
        });
    }

    /** { email } Remove Balimda's access to the user's Google account. */
    @PluginMethod
    public void signOut(PluginCall call) {
        String email = call.getString("email");
        if (email == null || email.isEmpty()) {
            call.resolve();
            return;
        }
        RevokeAccessRequest request = RevokeAccessRequest.builder()
            .setAccount(new Account(email, "com.google"))
            .setScopes(SCOPES)
            .build();
        Identity.getAuthorizationClient(getActivity())
            .revokeAccess(request)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> call.resolve());
    }
}
