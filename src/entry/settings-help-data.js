export const selectorFor = (id) => `label[for="${id}"]`;
export const controlFor = (id) => `#${id}`;

export const basicHelp = ({ selector, title, short, controls, controlsText, when, risk }) => ({
    selector,
    title,
    short,
    detail: `${controlsText} ${when} ${risk}`,
    controls,
});

const CONNECTION_GROUPS = [
    {
        key: 'layer0',
        label: 'Layer 0',
        route: 'main raw-chat summarizer route used for new Layer 0 memories and Layer 0 regeneration.',
        sourceId: 'summaryception_connection_source',
        responseLengthId: 'sc_summarizer_response_length',
        requestTimeoutId: 'sc_request_timeout',
        profileId: 'summaryception_connection_profile',
        sourceRisk: 'A weak or misconfigured route makes every new summary worse.',
        responseDefault: '0 uses the selected provider default.',
    },
    {
        key: 'merge',
        label: 'Merge',
        route: 'optional Layer 1+ promotion route used when lower memories are merged into deeper memory.',
        sourceId: 'summaryception_merge_connection_source',
        responseLengthId: 'sc_merge_summarizer_response_length',
        requestTimeoutId: 'sc_merge_request_timeout',
        profileId: 'summaryception_merge_connection_profile',
        sourceRisk: 'A mismatched merge route can rewrite stable memory in a different style.',
        responseDefault: '0 uses the selected provider default.',
    },
    {
        key: 'fallback',
        label: 'Fallback',
        route: 'backup summarizer route used only after retryable primary failures.',
        sourceId: 'summaryception_fallback_connection_source',
        responseLengthId: 'sc_fallback_summarizer_response_length',
        requestTimeoutId: 'sc_fallback_request_timeout',
        profileId: 'summaryception_fallback_connection_profile',
        sourceRisk: 'It is ignored if it matches the primary route.',
        responseDefault: '0 uses the selected provider default.',
    },
];

const CONNECTION_ENTRY_BUILDERS = [
    connectionSourceHelp,
    responseLengthHelp,
    requestTimeoutHelp,
    profileHelp,
];

export const CONNECTION_HELP_ENTRIES = CONNECTION_GROUPS.flatMap((group) =>
    CONNECTION_ENTRY_BUILDERS.map((build) => build(group)).filter(Boolean),
);

function connectionSourceHelp(group) {
    return [
        `${group.key}_source`,
        basicHelp({
            selector: selectorFor(group.sourceId),
            title: `${group.label} Source`,
            short: getConnectionSourceShort(group),
            controls: [controlFor(group.sourceId)],
            controlsText: `Controls the ${group.route}`,
            when: getConnectionSourceWhen(group),
            risk: group.sourceRisk,
        }),
    ];
}

function responseLengthHelp(group) {
    return [
        `${group.key}_response_length`,
        basicHelp({
            selector: selectorFor(group.responseLengthId),
            title: `${group.label} Response Length`,
            short: 'Maximum response length for default/profile routes.',
            controls: [controlFor(group.responseLengthId)],
            controlsText: `Controls the response length cap for the ${group.route}`,
            when: 'Use it if a provider rejects large non-streaming limits or you need shorter summaries.',
            risk: `Setting it too low can cut off summaries. ${group.responseDefault}`,
        }),
    ];
}

function requestTimeoutHelp(group) {
    return [
        `${group.key}_request_timeout`,
        basicHelp({
            selector: selectorFor(group.requestTimeoutId),
            title: `${group.label} Request Timeout`,
            short: 'Per-attempt timeout in seconds before the request is aborted and retried.',
            controls: [controlFor(group.requestTimeoutId)],
            controlsText: `Controls how long a single ${group.label} summarizer attempt waits before giving up.`,
            when: 'Raise it for slow local models that legitimately exceed the default. Lower it to fail over faster.',
            risk: 'Too low aborts valid slow responses; too high stalls the chat on a hung backend.',
        }),
    ];
}

function profileHelp(group) {
    return [
        `${group.key}_profile`,
        basicHelp({
            selector: selectorFor(group.profileId),
            title: `${group.label} Profile`,
            short: 'Saved SillyTavern connection profile for this route.',
            controls: [controlFor(group.profileId)],
            controlsText: `Controls which saved SillyTavern Connection Profile powers the ${group.route}`,
            when: 'Use it if you selected Connection Profile as the source.',
            risk: 'Profile formatting and model choice can change summary quality.',
        }),
    ];
}

function getConnectionSourceShort(group) {
    if (group.key === 'fallback') {
        return 'Backup route after retryable primary failures.';
    }
    if (group.key === 'merge') {
        return 'Optional route for deeper memory merges.';
    }
    return 'Route used for raw chat to Layer 0 summaries.';
}

function getConnectionSourceWhen(group) {
    if (group.key === 'fallback') {
        return 'Only use it if you have a second working route. Leave it disabled otherwise.';
    }
    if (group.key === 'merge') {
        return 'Use it if deeper memory merges need a different or stronger model.';
    }
    return 'Use it when the default route is not the best summarizer.';
}
