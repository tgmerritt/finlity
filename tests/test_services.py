"""
Tests for service layer modules.
"""


class TestPayrollTaxCalculator:
    """Test payroll tax calculations."""

    def test_calculator_import(self):
        """Test that calculator can be imported."""
        from src.budget.tax_calculator import PayrollTaxCalculator
        calculator = PayrollTaxCalculator()
        assert calculator is not None

    def test_calculate_paycheck_single(self):
        """Test paycheck calculation for single filer."""
        from src.budget.tax_calculator import PayrollTaxCalculator

        calculator = PayrollTaxCalculator(
            filing_status="single",
            state="CA",
            tax_year=2024
        )

        result = calculator.calculate_paycheck(
            gross_per_period=3846.15,
            pay_frequency="biweekly"
        )

        # Result is a PaycheckBreakdown dataclass
        assert hasattr(result, 'gross')
        assert hasattr(result, 'federal_income_tax')
        assert hasattr(result, 'social_security')
        assert hasattr(result, 'medicare')
        assert result.gross == 3846.15
        assert result.federal_income_tax > 0
        assert result.social_security > 0

    def test_calculate_paycheck_with_deductions(self):
        """Test paycheck with pre-tax deductions."""
        from src.budget.tax_calculator import PayrollTaxCalculator

        calculator = PayrollTaxCalculator(
            filing_status="single",
            state="CA",
            tax_year=2024
        )

        result_no_deductions = calculator.calculate_paycheck(
            gross_per_period=3846.15,
            pay_frequency="biweekly"
        )

        result_with_deductions = calculator.calculate_paycheck(
            gross_per_period=3846.15,
            pay_frequency="biweekly",
            pretax_deductions={"401k": 500}
        )

        # Pre-tax deductions should reduce taxable income and thus federal tax
        assert result_with_deductions.federal_income_tax < result_no_deductions.federal_income_tax

    def test_calculate_annual_summary(self):
        """Test annual tax summary."""
        from src.budget.tax_calculator import PayrollTaxCalculator

        calculator = PayrollTaxCalculator(
            filing_status="single",
            state="CA",
            tax_year=2024
        )

        result = calculator.calculate_annual_summary(
            annual_gross=100000
        )

        # Result is a dict for annual summary
        assert "gross_income" in result
        assert "federal_income_tax" in result
        assert "net_income" in result
        assert result["net_income"] < result["gross_income"]

    def test_no_state_tax_states(self):
        """Test states with no income tax."""
        from src.budget.tax_calculator import PayrollTaxCalculator

        # Texas has no state income tax
        calculator = PayrollTaxCalculator(
            filing_status="single",
            state="TX",
            tax_year=2024
        )

        result = calculator.calculate_paycheck(
            gross_per_period=3846.15,
            pay_frequency="biweekly"
        )

        assert result.state_income_tax == 0


class TestSocialSecurityEstimator:
    """Test Social Security benefit estimation."""

    def test_estimator_import(self):
        """Test that estimator can be imported."""
        from src.budget.social_security import estimate_social_security_benefit
        assert estimate_social_security_benefit is not None

    def test_basic_estimate(self):
        """Test basic SS benefit estimate."""
        from src.budget.social_security import estimate_social_security_benefit

        result = estimate_social_security_benefit(
            annual_income=100000,
            current_age=45,
            claiming_age=67,
            birth_year=1980
        )

        # Result is a SocialSecurityEstimate dataclass
        assert hasattr(result, 'monthly_benefit_at_fra') or hasattr(result, 'monthly_benefit')
        assert hasattr(result, 'claiming_age')
        assert result.claiming_age == 67


class TestTriggersEngine:
    """Test allocation triggers evaluation."""

    def test_trigger_service_import(self):
        """Test that trigger service can be imported."""
        from src.services.triggers import TriggerEvaluator
        assert TriggerEvaluator is not None

    def test_trigger_evaluator_creation(self):
        """Test creating a trigger evaluator."""
        from src.services.triggers import TriggerEvaluator
        from src.database import get_database

        db = get_database()
        evaluator = TriggerEvaluator(db)
        assert evaluator is not None


class TestMonteCarloEngine:
    """Test Monte Carlo simulation engine."""

    def test_engine_import(self):
        """Test that engine can be imported."""
        from src.projections.engine import MonteCarloEngine
        assert MonteCarloEngine is not None

    def test_engine_methods(self):
        """Test that engine has expected methods."""
        from src.projections.engine import MonteCarloEngine

        engine = MonteCarloEngine()

        # Check for expected methods
        assert hasattr(engine, 'run_projection')
        assert hasattr(engine, 'calculate_fire_number')
        assert hasattr(engine, 'estimate_years_to_fire')

    def test_fire_calculation(self):
        """Test FIRE number calculation."""
        from src.projections.engine import MonteCarloEngine

        engine = MonteCarloEngine()

        fire_number = engine.calculate_fire_number(
            annual_spending=50000,
            withdrawal_rate=0.04
        )

        # FIRE number = annual_spending / withdrawal_rate
        assert fire_number == 1250000

    def test_gpu_availability_property(self):
        """Test GPU availability property."""
        from src.projections.engine import MonteCarloEngine

        engine = MonteCarloEngine()

        # Properties should exist
        assert hasattr(engine, 'gpu_available')
        assert hasattr(engine, 'using_gpu')
        assert hasattr(engine, 'prefer_gpu')

        # GPU available should be a boolean
        assert isinstance(engine.gpu_available, bool)
        assert isinstance(engine.using_gpu, bool)

    def test_vectorized_batch_function(self):
        """Test vectorized simulation batch function."""
        from src.projections.engine import _run_simulation_batch_vectorized
        import numpy as np

        result = _run_simulation_batch_vectorized(
            batch_size=100,
            years=30,
            current_age=35,
            retirement_age=65,
            current_balance=100000,
            monthly_contribution=1000,
            monthly_withdrawal=4000,
            stock_allocation=0.7,
            bond_allocation=0.25,
            cash_allocation=0.05,
            stock_mean=0.09,
            stock_std=0.15,
            bond_mean=0.04,
            bond_std=0.06,
            inflation=0.03,
            black_swan_prob=0.02,
            black_swan_impact=-0.40,
            golden_swan_prob=0.02,
            golden_swan_impact=0.27,
            t_df=5,
            random_seed=42,
        )

        # Result should be a 2D array with correct shape
        assert isinstance(result, np.ndarray)
        assert result.shape == (100, 30)

        # Initial values should all be current_balance
        assert np.all(result[:, 0] == 100000)

        # Values should not be negative (we enforce max(0, ...))
        assert np.all(result >= 0)

    def test_run_simulation_batch_simple_mode(self):
        """Test batch simulation in simple mode uses vectorized version."""
        from src.projections.engine import _run_simulation_batch
        import numpy as np

        result = _run_simulation_batch(
            batch_size=50,
            years=20,
            current_age=40,
            retirement_age=65,
            current_balance=200000,
            monthly_contribution=500,
            monthly_withdrawal=3000,
            stock_allocation=0.6,
            bond_allocation=0.35,
            cash_allocation=0.05,
            stock_mean=0.08,
            stock_std=0.12,
            bond_mean=0.035,
            bond_std=0.05,
            inflation=0.025,
            black_swan_prob=0.01,
            black_swan_impact=-0.35,
            golden_swan_prob=0.01,
            golden_swan_impact=0.25,
            t_df=6,
            use_tax_aware=False,  # Simple mode
            random_seed=123,
        )

        assert isinstance(result, np.ndarray)
        assert result.shape == (50, 20)
        assert np.all(result[:, 0] == 200000)


class TestSecretsManager:
    """Test secrets manager with Fernet encryption."""

    def test_secrets_manager_import(self):
        """Test that SecretsManager can be imported."""
        from src.services.secrets import SecretsManager
        assert SecretsManager is not None

    def test_fernet_encryption_roundtrip(self, test_env):
        """Test that values are properly encrypted and decrypted."""
        from src.services.secrets import SecretsManager
        from src.database import get_database
        import os

        # Set a test SECRET_KEY
        original_key = os.environ.get("SECRET_KEY")
        os.environ["SECRET_KEY"] = "test_secret_key_for_testing_purposes_only"

        try:
            db = get_database()
            manager = SecretsManager(db)

            # Test encode/decode roundtrip
            test_value = "sk-test-api-key-12345"
            encoded = manager._encode(test_value)

            # Encoded value should be prefixed with 'fernet:'
            assert encoded.startswith("fernet:")

            # Encoded value should not contain the original (not base64)
            assert test_value not in encoded

            # Decode should return original value
            decoded = manager._decode(encoded)
            assert decoded == test_value
        finally:
            # Restore original key
            if original_key:
                os.environ["SECRET_KEY"] = original_key
            elif "SECRET_KEY" in os.environ:
                del os.environ["SECRET_KEY"]

    def test_legacy_base64_decoding(self, test_env):
        """Test backward compatibility with legacy base64-encoded values."""
        from src.services.secrets import SecretsManager
        from src.database import get_database
        import base64

        db = get_database()
        manager = SecretsManager(db)

        # Simulate a legacy base64-encoded value (no 'fernet:' prefix)
        original_value = "old-api-key-abc123"
        legacy_encoded = base64.b64encode(original_value.encode()).decode()

        # Should decode correctly (with a warning in logs)
        decoded = manager._decode(legacy_encoded)
        assert decoded == original_value

    def test_get_or_create_encryption_key(self):
        """Test encryption key generation."""
        from src.services.secrets import _get_or_create_encryption_key

        key = _get_or_create_encryption_key()

        # Key should be bytes
        assert isinstance(key, bytes)

        # Fernet keys are 44 bytes (32 bytes base64-encoded)
        assert len(key) == 44

    def test_mask_key(self, test_env):
        """Test API key masking."""
        from src.services.secrets import SecretsManager
        from src.database import get_database

        db = get_database()
        manager = SecretsManager(db)

        # Test normal key masking
        masked = manager.mask_key("sk-ant-api03-1234567890abcdefghij")
        assert masked.startswith("sk-a")
        assert masked.endswith("ghij")
        assert "..." in masked

        # Test short key
        masked_short = manager.mask_key("short")
        assert masked_short == "****"
