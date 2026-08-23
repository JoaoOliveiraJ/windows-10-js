// ===========================================================================
// jsOS - system32/win32/ntoskrnl/etw.js: exports ETW (Event Tracing for
// Windows) para drivers. Provedores sao registrados de verdade (tabela por
// GUID) e os eventos escritos viram linhas de trace na serial (o sink do
// jsOS) com o handle do provedor.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');

const providers = new Map();   // handle -> { guidText, enabled }
let nextProviderHandle = 0x900;

function guidToText(guidPointer) {
    let text = '';
    for (let i = 0; i < 16; i++)
        text += GuestMemory.readGuest8(guidPointer + i).toString(16).padStart(2, '0');
    return text;
}

module.exports = {
    names: [
        'EtwRegister',
        'EtwUnregister',
        'EtwWrite',
        'EtwWriteTransfer',
        'EtwSetInformation',
        'EtwRegisterClassicProvider',
    ],
    handlers: [
        // EtwRegister(providerGuidPtr, enableCallback, callbackCtx, outHandle)
        (guidPointer, _enableCallback, _callbackContext, outHandlePointer) => {
            const handle = nextProviderHandle++;
            providers.set(handle, { guidText: guidToText(guidPointer),
                                    enabled: true });
            GuestMemory.writeGuest64(outHandlePointer, handle);
            return 0;
        },
        // EtwUnregister(handle)
        (providerHandle) => {
            providers.delete(providerHandle >>> 0);
            return 0;
        },
        // EtwWrite(handle, eventDescriptorPtr, activityIdPtr, ...userData)
        (providerHandle, _descriptorPointer, _activityIdPointer) => {
            const provider = providers.get(providerHandle >>> 0);
            os.debugPrint('[etw:' + (provider ? provider.guidText.slice(0, 8)
                                              : '?') + '] evento');
            return 0;
        },
        // EtwWriteTransfer(handle, descriptor, activityId, relatedId, ...)
        (providerHandle, _descriptorPointer, _activityIdPointer,
         _relatedActivityIdPointer) => {
            const provider = providers.get(providerHandle >>> 0);
            os.debugPrint('[etw:' + (provider ? provider.guidText.slice(0, 8)
                                              : '?') + '] transfer');
            return 0;
        },
        // EtwSetInformation(handle, infoClass, infoBuffer, infoSize)
        (providerHandle, informationClass, informationPointer,
         _informationSize) => {
            const provider = providers.get(providerHandle >>> 0);
            if (!provider) return 0xC0000008 | 0;   // STATUS_INVALID_HANDLE
            if ((informationClass >>> 0) === 1 && informationPointer) {
                // EventProviderSetTraits: guarda os traits do provedor
                provider.traitsLength = GuestMemory.readGuest32(informationPointer);
            }
            return 0;
        },
        // EtwRegisterClassicProvider(providerGuidPtr, type, callback, ctx,
        //                            outHandle): variante classica do register
        (guidPointer, _providerType, _enableCallback, _callbackContext,
         outHandlePointer) => {
            const handle = nextProviderHandle++;
            providers.set(handle, { guidText: guidToText(guidPointer),
                                    enabled: true });
            GuestMemory.writeGuest64(outHandlePointer, handle);
            return 0;
        },
    ],
};
