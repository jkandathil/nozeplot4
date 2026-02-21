import React from 'react';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        this.setState({ error: error, errorInfo: errorInfo });
        console.error("ErrorBoundary caught an error:", error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{ padding: '20px', background: '#fee2e2', color: '#991b1b', borderRadius: '8px', margin: '20px', fontFamily: 'monospace', overflow: 'auto', maxHeight: '100vh', zIndex: 999999, position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}>
                    <h2 style={{ fontSize: '24px', fontWeight: 'bold' }}>Application Crashed!</h2>
                    <p>Please copy the text below and paste it into the AI chat:</p>
                    <hr style={{ borderColor: '#fca5a5' }} />
                    <h3 style={{ marginTop: '20px' }}>Error:</h3>
                    <pre style={{ background: '#fef2f2', padding: '10px', borderRadius: '4px' }}>
                        {this.state.error && this.state.error.toString()}
                    </pre>
                    <h3>Stack Trace:</h3>
                    <pre style={{ background: '#fef2f2', padding: '10px', borderRadius: '4px', whiteSpace: 'pre-wrap' }}>
                        {this.state.errorInfo && this.state.errorInfo.componentStack}
                    </pre>
                </div>
            );
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
